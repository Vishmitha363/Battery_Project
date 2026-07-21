// ======================================
// BMS DASHBOARD SCRIPT
// ======================================

// ------------------------------
// LOGIN CHECK
// ------------------------------

// sessionStorage, not localStorage — closing the tab fully clears
// this automatically, so reopening the project always requires
// logging in again instead of silently staying signed in.
if (sessionStorage.getItem("loggedIn") !== "true") {
    window.location.href = "login.html";
}

// ------------------------------
// CONSTANTS
// ------------------------------

let CELL_COUNT = 16;

const MAX_CAPACITY_AH = 10.00;

const CELL_COLORS = [
    "#16a34a", "#2563eb", "#d97706", "#9333ea",
    "#0d9488", "#db2777", "#65a30d", "#dc2626",
    "#ca8a04", "#0891b2", "#9333ea", "#16a34a",
    "#ea580c", "#dc2626", "#db2777", "#0891b2"
];

// ------------------------------
// STATE
// ------------------------------

let running = false;
let seconds = 0;
let timer = null;

let cellVoltages = new Array(CELL_COUNT).fill(0);

// true while a cell is tripped on over-voltage / under-voltage protection
let cellOVFault = new Array(CELL_COUNT).fill(false);
let cellUVFault = new Array(CELL_COUNT).fill(false);

// true while a cell is currently above the balancing start voltage —
// tracked separately so we can detect the moment it stops (completion)
let cellBalancing = new Array(CELL_COUNT).fill(false);

// true while a cell is receiving charge. The mirror of cellBalancing[]
// for the other end of the transfer, and needed for the same reason:
// to catch the moment it starts.
let cellCharging = new Array(CELL_COUNT).fill(false);

// When set from Docklight ("$BALCELL:3,6#"), THIS is the balancing pair —
// { sender, receiver } as 0-based indices, receiver -1 for none. It overrides
// the dashboard's own highest→lowest pick, so the operator on Docklight
// decides which cells balance. null = the dashboard picks the pair itself.
let manualBalancePair = null;

// How many times each cell has begun discharging, and begun charging.
// Counted on the rising edge only — a cell that discharges for 200 ticks
// has discharged once, not 200 times. Works identically for simulated
// and real data, since both drive cellBalancing[] the same way.
let cellDischargeCount = new Array(CELL_COUNT).fill(0);
let cellChargeCount = new Array(CELL_COUNT).fill(0);

// Timestamp of each cell's last over-balance warning (0 = none yet). The
// warning repeats every 5 s while the cell stays over the limit.
let cellOverBalLastWarn = new Array(CELL_COUNT).fill(0);

const OVERBAL_WARN_REPEAT_MS = 5000;

// A cell is counted at most ONCE PER BALANCING CYCLE, on the first tick
// it discharges or charges in that cycle.
//
// Counting raw rising edges instead gives numbers nobody would call a
// count: the cells above the threshold take turns round-robin, so a
// single balance run reported 35-49 "discharges" per cell. Debouncing
// the edge cannot fix it either — with N cells above the threshold each
// sits out exactly N-1 ticks between turns, so no fixed gap works for
// every pack. "How many cycles did this cell take part in" is the
// question that has an answer, and it is bounded by the cycle count.
let cellDischargedThisCycle = new Array(CELL_COUNT).fill(false);
let cellChargedThisCycle = new Array(CELL_COUNT).fill(false);

// true between BALANCING START and BALANCING STOP. Distinct from
// cellBalancing[] above: that says which cells are over the start
// voltage, this says whether the balancer is switched on at all.
let balancingActive = false;

// How many times balancing has run TODAY, and how many of those ran all
// the way to a settled pack. Counted separately because they answer
// different questions: "3 cycles" says nothing about whether the battery
// ever actually balanced.
//
// These accumulate across every START/STOP for the whole calendar day
// and reset only when the date rolls over — the same lifetime as a day's
// CSV log file. Persisted to localStorage (see loadBalanceStatsForToday)
// so a page reload mid-day does not lose the running total.
let balancingCycleCount = 0;
let balancingCompletedCount = 0;

// A per-CELL safety — the only balancing limit now that the whole-pack
// cycle limit is gone. If any single cell has discharged or charged more
// than this many times today, that one cell is being worked too hard, so
// balancing is stopped at once. Warn while the count is in the 7..10
// band; stop the moment it goes past 10.
const CELL_TRANSFER_WARN_AT = 7;
const CELL_TRANSFER_LIMIT = 10;

// The worst per-cell tally right now: the highest discharge OR charge
// count across every cell. Drives both the warning band and the stop.
function maxCellTransferCount() {

    let max = 0;

    for (let i = 0; i < CELL_COUNT; i++) {

        if (cellDischargeCount[i] > max) max = cellDischargeCount[i];
        if (cellChargeCount[i] > max) max = cellChargeCount[i];

    }

    return max;

}

// Set when the daily limit is hit. Blocks further balancing for the rest
// of the DAY — persists with the counts above and clears only at the
// date rollover, not at STOP/START. Otherwise a start after lockout
// would clear the flag while leaving the count at the limit, and the
// very next completed cycle would re-lock immediately.
let balancingLockedOut = false;

// localStorage key for the per-day balancing totals above. Its stored
// date decides whether today continues an existing tally or begins a
// fresh one.
const BALANCE_STATS_KEY = "balanceStatsByDay";

// Loads today's saved totals, or starts a clean day if the saved date is
// not today (or nothing is saved). Called at startup and again whenever
// a date rollover is detected while the app is left running.
function loadBalanceStatsForToday() {

    let saved = null;

    try {

        saved = JSON.parse(localStorage.getItem(BALANCE_STATS_KEY));

    }

    catch (e) {

        saved = null;

    }

    if (saved && saved.date === todayDateStr()) {

        balancingCycleCount = saved.cycleCount || 0;
        balancingCompletedCount = saved.completedCount || 0;
        balancingLockedOut = !!saved.lockedOut;

        // A cell count that no longer matches means the pack was
        // reconfigured; the old per-cell tallies no longer line up, so
        // start those fresh rather than mis-attribute them.
        if (Array.isArray(saved.dischargeCounts) && saved.dischargeCounts.length === CELL_COUNT) {

            cellDischargeCount = saved.dischargeCounts.slice();
            cellChargeCount = saved.chargeCounts.slice();

        }

    }

    else {

        balancingCycleCount = 0;
        balancingCompletedCount = 0;
        balancingLockedOut = false;
        cellDischargeCount = new Array(CELL_COUNT).fill(0);
        cellChargeCount = new Array(CELL_COUNT).fill(0);

        saveBalanceStats();

    }

    balanceStatsDate = todayDateStr();

}

// Writes the current totals under today's date. Called from every point
// that changes a counter, so a reload never loses more than nothing.
function saveBalanceStats() {

    try {

        localStorage.setItem(BALANCE_STATS_KEY, JSON.stringify({
            date: todayDateStr(),
            cycleCount: balancingCycleCount,
            completedCount: balancingCompletedCount,
            lockedOut: balancingLockedOut,
            dischargeCounts: cellDischargeCount,
            chargeCounts: cellChargeCount
        }));

    }

    catch (e) {

        console.log("Could not save balancing stats:", e);

    }

}

// The date the loaded totals belong to. When the wall-clock day moves
// past this, the tally rolls over to a fresh day.
let balanceStatsDate = null;

// Detects the midnight rollover for a page left open across days. Called
// each tick; cheap, since it is a string compare until the day actually
// changes.
function rollBalanceStatsIfNewDay() {

    if (balanceStatsDate !== null && balanceStatsDate === todayDateStr()) return;

    // A balance in progress at midnight is stopped, so the new day starts
    // from a clean, non-balancing state rather than mid-cycle.
    if (balancingActive) stopBalancing();

    loadBalanceStatsForToday();

    updateBalancingCycleStat();

}

// How often liveDataTick() runs. The balancing ETA converts ticks to
// seconds with this, so the two must never drift apart.
const TICK_MS = 1500;

// The balancer's duty cycle: it balances for BALANCE_ON_S, rests for
// BALANCE_OFF_S, and repeats. The completion-time estimate stretches the
// pure balancing time by these rest gaps. (1 min 40 s on, 5 s off.)
const BALANCE_ON_S = 100;
const BALANCE_OFF_S = 5;

// A real board bleeds at whatever rate its hardware bleeds at — the
// dashboard cannot know it, because converting volts to charge needs a
// capacity curve we don't have. So we watch the discharging cell fall
// and measure the rate instead of assuming one. Volts per second,
// smoothed; 0 means "nothing measured yet".
let observedDropVoltsPerSecond = 0;

// Last reading of the discharging cell, for the delta above.
let lastBalanceSample = null;

// When the balance is projected to finish, as a timestamp.
//
// Snapshotted once when balancing starts, then simply counted down.
// Recomputing it every tick made the figure jitter: the untouched cells
// are still doing a ±10mV random walk, so the pack's total excess — and
// therefore the estimate — wobbles from tick to tick. A countdown that
// jumps around is worse than useless. Re-snapshotted only when an input
// it depends on actually changes (the Equalizing Current or Starting
// Voltage), because then the old projection really is wrong.
let balanceDeadlineAt = null;

// ------------------------------
// ACTIVITY LOG
// ------------------------------

// The Activity Log is the history of the process — it must survive
// page reloads, logout/login cycles and "Restart System", not just
// live in memory for the current tab. Persisted to localStorage and
// restored on load. Kept as two separate logs — Real device history
// and Automatic Values history must never mix, same as the CSV files.
const MAX_LOG_ENTRIES = 500;

let activityLogs = { Real: [], Automatic: [] };

for (const source of ["Real", "Automatic"]) {

    try {

        activityLogs[source] = JSON.parse(localStorage.getItem(`activityLog_${source}`)) || [];

    } catch (error) {

        activityLogs[source] = [];

    }

}

// One-time migration from the old single combined log, if present.
if (localStorage.getItem("activityLog") && activityLogs.Real.length === 0 && activityLogs.Automatic.length === 0) {

    try {

        activityLogs.Automatic = JSON.parse(localStorage.getItem("activityLog")) || [];
        localStorage.setItem("activityLog_Automatic", JSON.stringify(activityLogs.Automatic));

    } catch (error) {}

    localStorage.removeItem("activityLog");

}

// Which log is currently shown in the panel — defaults to whatever
// matches the live session, but a manual tab click can peek at the
// other one without it snapping back on its own.
let viewingLogSource = null;

function logEvent(message, type = "info") {

    const source = currentDataSourceLabel();
    const log = activityLogs[source];

    log.unshift({ time: formatDisplayDateTime(new Date()), message, type });

    if (log.length > MAX_LOG_ENTRIES) log.length = MAX_LOG_ENTRIES;

    localStorage.setItem(`activityLog_${source}`, JSON.stringify(log));

    renderActivityLog();

}

function switchLogView(source) {

    viewingLogSource = source;

    renderActivityLog();

}

function renderActivityLog() {

    const list = document.getElementById("logList");

    if (!list) return;

    const source = viewingLogSource || currentDataSourceLabel();
    const log = activityLogs[source];

    document.querySelectorAll(".log-tab-btn").forEach(btn => {

        btn.classList.toggle("active", btn.dataset.source === source);

    });

    if (log.length === 0) {

        list.innerHTML = `<p class="log-empty" id="logEmpty">No ${source.toLowerCase()} activity yet</p>`;

        return;

    }

    list.innerHTML = log
        .map(entry => `
            <div class="log-entry log-${entry.type}">
                <span class="log-time">${entry.time}</span>
                <span class="log-message">${entry.message}</span>
            </div>
        `)
        .join("");

}

// Permanently wipes whichever log is currently being viewed — a
// deliberate reset the user asked for, not something that should ever
// happen by accident, hence the confirmation before it touches anything.
function clearActivityLog() {

    const source = viewingLogSource || currentDataSourceLabel();

    if (activityLogs[source].length === 0) {

        alert(`No ${source.toLowerCase()} activity to clear.`);

        return;

    }

    if (!confirm(`Clear all ${source} activity log history? This cannot be undone.`)) return;

    activityLogs[source] = [];

    localStorage.setItem(`activityLog_${source}`, JSON.stringify(activityLogs[source]));

    renderActivityLog();

}

// Downloads the log currently being viewed as a plain-text file,
// oldest entry first (reads like a timeline), for sharing with
// someone troubleshooting a field issue without needing screen-share.
function exportActivityLog() {

    const source = viewingLogSource || currentDataSourceLabel();
    const log = activityLogs[source];

    if (log.length === 0) {

        alert(`No ${source.toLowerCase()} activity to export yet.`);

        return;

    }

    const lines = [...log]
        .reverse()
        .map(entry => `[${entry.time}] [${entry.type.toUpperCase()}] ${entry.message}`);

    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");

    link.href = url;
    link.download = `BMS_ActivityLog_${todayDateStr()}_${csvTimeStr().replace(/:/g, "-")}.txt`;

    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    URL.revokeObjectURL(url);

    logEvent("⬇ Activity Log Exported", "info");

}

// ------------------------------
// REAL DEVICE (Web Serial API) — optional.
// Works alongside the simulation: connected = real readings drive
// the dashboard, not connected = simulated data keeps running, so
// the app always works both with and without hardware attached.
// ------------------------------

let realPort = null;
let realReader = null;
let realDeviceConnected = false;
let realLineBuffer = "";

// When the board last sent a frame we could read cell voltages from.
// null means "connected, but has never sent one". A board that goes
// quiet leaves the cells frozen on its last reading — indistinguishable
// from a stalled balancer unless we surface this.
let lastCellFrameAt = null;

// The ALERT PIN indicator: green (normal) until the board's watchdog
// warning arrives, then red until the user clicks to acknowledge.
let alertPinActive = false;

function triggerAlertPin() {

    // Idempotent — only act on the transition to red, so a repeated
    // warning doesn't spam the log while the pin is already alerting.
    if (alertPinActive) return;

    alertPinActive = true;

    const pin = document.getElementById("alertPin");
    const label = document.getElementById("alertPinLabel");

    if (pin) pin.classList.add("alerted");
    if (label) label.textContent = "ALERT PIN : WATCHDOG!";

    logEvent("🚨 Watchdog Warning — EXTI3 Stalled, Communication Re-initialized", "error");
    showStatus("🚨 ALERT PIN — Watchdog Warning (EXTI3)", "stop");

}

function resetAlertPin() {

    alertPinActive = false;

    const pin = document.getElementById("alertPin");
    const label = document.getElementById("alertPinLabel");

    if (pin) pin.classList.remove("alerted");
    if (label) label.textContent = "ALERT PIN : NORMAL";

}

// AFE (the chip that reads the cells) communication health. Toggles green
// (OK) / red (FAIL) on the matching board messages — no manual reset, the
// OK message clears a prior fail on its own. afeFailed drives a banner in
// checkWarnings() so a failure stays on screen while it lasts.
let afeFailed = false;

function setAfeStatus(ok) {

    // Only log on a real change of state, not on every repeated message.
    const changed = ok === afeFailed;

    afeFailed = !ok;

    const el = document.getElementById("afeStatus");
    const label = document.getElementById("afeStatusLabel");

    if (el) {

        el.classList.toggle("ok", ok);
        el.classList.toggle("fail", !ok);

    }

    if (label) label.textContent = ok ? "AFE : OK" : "AFE : FAIL";

    if (changed) {

        if (ok) logEvent("✅ AFE Communication OK", "success");
        else {
            logEvent("🚨 AFE Communication Fail — cell readings may be unreliable", "error");
            showStatus("🚨 AFE Communication Fail", "stop");
        }

    }

}

// Balancer expander (MCP23017 #1 / #2) comm faults. Each chip tracked
// separately; "BALANCER : NORMAL" clears both. A fault means the balancer
// hardware can't act, so it also blocks BALANCING START and raises a
// banner (see checkWarnings) and log entry.
let mcp1Failed = false;
let mcp2Failed = false;
let lastBalancerState = "OK";

function balancerFaulted() {

    return mcp1Failed || mcp2Failed;

}

function updateBalancerStatus() {

    const faults = [];
    if (mcp1Failed) faults.push("MCP1");
    if (mcp2Failed) faults.push("MCP2");

    const faulted = faults.length > 0;

    const badge = document.getElementById("balancerStatus");
    const label = document.getElementById("balancerStatusLabel");

    if (badge) {

        badge.classList.toggle("ok", !faulted);
        badge.classList.toggle("fail", faulted);

    }

    if (label) {

        label.textContent = faulted
            ? `BALANCER : ${faults.join("+")} FAIL`
            : "BALANCER : NORMAL";

    }

    // Block BALANCING START while the hardware is faulted — but never
    // fight the button state while a balance is already running.
    const balStart = document.getElementById("balStartBtn");

    if (balStart && !balancingActive) {

        balStart.disabled = faulted || balancingLockedOut;

    }

    // Log only on a genuine change of state, not every repeated message.
    const state = faults.join("+") || "OK";

    if (state !== lastBalancerState) {

        lastBalancerState = state;

        if (faulted) {

            logEvent(`🚨 Balancer Fault — ${faults.join(" & ")} COMM FAIL`, "error");
            showStatus(`🚨 Balancer Fault — ${faults.join(" & ")}`, "stop");

        }

        else logEvent("✅ Balancer Normal", "success");

    }

}

function setDeviceStatus(connected) {

    realDeviceConnected = connected;

    const dot = document.getElementById("deviceDot");
    const label = document.getElementById("deviceStatusLabel");

    if (dot) dot.className = "status-dot " + (connected ? "connected" : "disconnected");

    // The dot says whether a port is open. The label says where the
    // NUMBERS come from — a different question, since an open port to
    // Docklight supplies no cell data at all.
    if (label) {

        label.textContent = simulationEnabled
            ? (connected ? "Port Open · Simulated Data" : "Simulated Data")
            : (connected ? "Real Device Data" : "No Device — No Data");

    }

}

// Runs once on dashboard load. Web Serial permission granted on any
// page (e.g. the "Connect BMS" step at login) is remembered for the
// whole site, not just that one page — so the device is reopened
// here silently instead of making the user connect it a second time.
//
// Runs on the Automatic Values path too. Opening a port does not decide
// where the numbers come from — simulationEnabled does, and it only
// yields to real "$CELL...#" frames. So an Automatic session can still
// hold a COM link open to Docklight and stream its simulated readings
// out to it, which is exactly the two-port test setup.
// The baud rate chosen at login. It must match the device exactly: at the
// wrong rate the port opens happily and simply delivers unreadable bytes,
// which looks identical to a device that is sending nothing at all.
function savedBaudRate() {

    const value = parseInt(localStorage.getItem("bmsBaudRate"), 10);

    return !isNaN(value) && value > 0 ? value : 115200;

}

// Opens ONE specific port and starts reading it. Whatever port is passed in
// is the port that gets opened — never "whichever one opens first", which is
// how a stale port from an earlier session ends up being read instead of the
// board the user actually picked.
async function connectToPort(candidate) {

    try {

        await candidate.open({ baudRate: savedBaudRate() });

    }

    catch (error) {

        console.log("Could not open port:", error);

        return false;

    }

    realPort = candidate;

    setDeviceStatus(true);

    // A fresh connection has heard nothing yet, whatever an earlier
    // one may have heard.
    lastCellFrameAt = null;

    // Deliberately NOT disabling simulation or zeroing the cells here.
    // An open port is not a source of cell voltages — it may lead to
    // Docklight, which never sends any. Simulation stops the moment
    // real "$CELL...#" data actually arrives, and not before.

    readRealDeviceLoop();

    return true;

}

async function autoConnectRealDevice() {

    if (!("serial" in navigator)) return;

    const ports = await navigator.serial.getPorts();

    if (ports.length === 0) {

        showStatus("⚠ No Authorised Port — Connect The Device At Login", "stop");
        logEvent("⚠ No Authorised Serial Port Found", "error");

        return;

    }

    // Try EVERY authorised port, not just the first. The browser remembers
    // every port ever granted, so ports[0] is often a stale one from an
    // earlier session rather than the board just connected at login.
    for (const candidate of ports) {

        if (await connectToPort(candidate)) {

            showStatus("🔌 Real Device Connected — Live Hardware Data", "success");
            logEvent("🔌 Real Device Connected (From Login)", "success");

            return;

        }

    }

    // Every port refused. Failing silently here is exactly what makes a
    // successful login look like a dashboard that just shows nothing, with
    // no clue that the port never opened at all.
    realPort = null;

    setDeviceStatus(false);

    showStatus("⚠ Could Not Open The Serial Port — It May Be In Use By Docklight", "stop");
    logEvent("⚠ Could Not Open Serial Port — It May Be In Use By Another Program", "error");

}

async function readRealDeviceLoop() {

    const decoder = new TextDecoderStream();

    const inputClosed = realPort.readable.pipeTo(decoder.writable);

    realReader = decoder.readable.getReader();

    try {

        while (true) {

            const { value, done } = await realReader.read();

            if (done) break;

            if (value) handleRealDeviceChunk(value);

        }

    }

    catch (error) {

        console.log(error);

    }

    finally {

        if (realReader) realReader.releaseLock();

        await inputClosed.catch(() => {});

        // realPort may already be null if the OS "disconnect" event fired
        // first and closed it — guard so cleanup (and the disconnect dialog
        // below) always runs instead of throwing on null.close().
        if (realPort) await realPort.close().catch(() => {});

        realPort = null;

        setDeviceStatus(false);

        // A deliberate logout is already navigating to login — don't fire a
        // "device disconnected" log/redirect on top of it.
        if (loggingOut) return;

        logEvent("🔌 Real Device Disconnected", "error");

        // Never keep a session/logging run going once the hardware it
        // was reading from is gone — auto-stop exactly like pressing
        // STOP, so nothing gets logged to disk as if it were still live.
        if (running) {

            logEvent("⛔ BMS Auto-Stopped — USB Device Disconnected", "error");

            stopBMS();

        }

        // Ask the operator what to do — reconnect the device or log out —
        // right here in the dashboard, instead of yanking them back to the
        // login page automatically.
        showDisconnectModal();

    }

}

// Rolling buffer of the last stretch of raw serial input, used ONLY for
// plain-text status-message detection (see detectStatusMessages). Separate
// from realLineBuffer because the $...# frame parser discards text between
// frames, which would lose a status line.
let rawStatusTail = "";

// Per-cell over-balancing warnings (board messages 8/9). Keyed by cell
// index → { dir:"FORWARD"|"REVERSE", runs, at }. Shown as an amber badge on
// the affected cell and cleared if no new warning arrives within the window.
let cellOverBalance = {};

const OVERBAL_EXPIRE_MS = 12000;

function registerOverBalance(cellIndex, dir, runs) {

    if (cellIndex < 0 || cellIndex >= CELL_COUNT) return;

    // Update in place — the badge always shows the latest run count.
    cellOverBalance[cellIndex] = { dir, runs, at: Date.now() };

    logEvent(`⚠ Cell ${cellIndex + 1} Over-Balancing — ${dir} path (${runs} runs)`, "error");
    showStatus(`⚠ Cell ${cellIndex + 1} Over-Balancing (${runs} runs)`, "stop");

}

// Scans the rolling raw buffer for the board's plain-text status lines and
// updates the ALERT PIN / AFE / BALANCER indicators. Each matched phrase is
// blanked out so it fires once per occurrence, not on every chunk while it
// lingers in the buffer.
function detectStatusMessages() {

    // Watchdog — "…EXTI3 Stalled…" → ALERT PIN red.
    if (/EXTI3/i.test(rawStatusTail)) {

        triggerAlertPin();
        rawStatusTail = rawStatusTail.replace(/EXTI3/ig, "·");

    }

    // Reset the ALERT PIN back to green from the serial side — send
    // "ALERT PIN OK" / "ALERT PIN NORMAL" / "WATCHDOG OK" from Docklight.
    if (/ALERT\s*(PIN)?\s*(OK|NORMAL)|WATCHDOG\s*(OK|NORMAL)/i.test(rawStatusTail)) {

        resetAlertPin();
        rawStatusTail = rawStatusTail.replace(/ALERT\s*(PIN)?\s*(OK|NORMAL)|WATCHDOG\s*(OK|NORMAL)/ig, "·");

    }

    // AFE comm — check Fail first (both share "AFE Communication").
    if (/AFE\s*Communication\s*Fail/i.test(rawStatusTail)) {

        setAfeStatus(false);
        rawStatusTail = rawStatusTail.replace(/AFE\s*Communication\s*Fail/ig, "·");

    }

    else if (/AFE\s*Communication\s*OK/i.test(rawStatusTail)) {

        setAfeStatus(true);
        rawStatusTail = rawStatusTail.replace(/AFE\s*Communication\s*OK/ig, "·");

    }

    // Balancer MCP23017 expander faults / recovery.
    let balancerMsg = false;

    if (/MCP23017\s*#?\s*1/i.test(rawStatusTail)) { mcp1Failed = true; balancerMsg = true; }

    if (/MCP23017\s*#?\s*2/i.test(rawStatusTail)) { mcp2Failed = true; balancerMsg = true; }

    if (/BALANCER\s*:?\s*NORMAL/i.test(rawStatusTail)) {

        mcp1Failed = false;
        mcp2Failed = false;
        balancerMsg = true;

    }

    if (balancerMsg) {

        updateBalancerStatus();
        rawStatusTail = rawStatusTail.replace(/MCP23017\s*#?\s*[12]|BALANCER\s*:?\s*NORMAL/ig, "·");

    }

    // Over-balancing warning: "…Cell03 is over-balancing in FORWARD path!
    // (1500 runs)". Pull out cell number, direction, and run count.
    const ob = rawStatusTail.match(
        /Cell\s*(\d+)\s+is\s+over-balancing\s+in\s+(FORWARD|REVERSE)\s+path[^(]*\((\d+)\s*runs?\)/i
    );

    if (ob) {

        registerOverBalance(parseInt(ob[1], 10) - 1, ob[2].toUpperCase(), parseInt(ob[3], 10));
        rawStatusTail = rawStatusTail.replace(ob[0], "·");

    }

}

// Balancing commands sent WITHOUT the $...# framing — e.g. plain
// "BAL : CELL03 -> CELL06", "BALSTART", "BALSTOP" typed straight into
// Docklight. The framed forms still work through applyRealDeviceLine();
// this lets the same commands arrive unframed on the raw stream too.
// Each match is blanked so it fires once, not on every chunk it lingers in.
function detectPlainBalancingCommand() {

    // BALSTART / BALSTOP as bare words (not part of a longer token).
    const startStop = rawStatusTail.match(/\bBAL\s*(START|STOP)\b/i);

    if (startStop) {

        if (/START/i.test(startStop[1])) { if (!balancingActive) startBalancing(false); }
        else { if (balancingActive) stopBalancing(false); }

        rawStatusTail = rawStatusTail.replace(startStop[0], "·");

        return;

    }

    // "BAL : CELL03 -> CELL06", "BAL:3,6", "BALCELL:3->6", or a lone
    // "BAL : CELL03" (discharge only). "CELL" and the separators are all
    // optional, mirroring the framed parser's accepted forms.
    const pair = rawStatusTail.match(
        /\bBAL\s*[:=]?\s*(?:CELL\s*[:=]?\s*)?(\d+)(?:\s*[-,>]+\s*(?:CELL\s*[:=]?\s*)?(\d+))?/i
    );

    if (pair) {

        setManualBalancePair(
            parseInt(pair[1], 10) - 1,
            pair[2] !== undefined ? parseInt(pair[2], 10) - 1 : -1
        );

        rawStatusTail = rawStatusTail.replace(pair[0], "·");

    }

}

// Messages from the board are framed as $...# rather than separated
// by newlines, e.g.:
// $CELL01:3500mV,CELL02:3400mV,CELL03:3600mV,CELL04:3600mV,CELL05:3200mV#
function handleRealDeviceChunk(chunk) {

    // Temporary raw diagnostic — shows exactly what bytes arrive,
    // regardless of whether they match the expected $...# framing.
    // JSON.stringify reveals hidden characters (\r, \n, control
    // bytes) that a plain console.log would hide.
    console.log("Raw chunk from device:", JSON.stringify(chunk));

    // Plain-text status messages (watchdog / AFE / balancer) are detected
    // on a SEPARATE rolling buffer, NOT on realLineBuffer. The $...# frame
    // parser below discards any text before a "$", so a status line that a
    // continuous cell frame interleaves with would be wiped off
    // realLineBuffer before it could assemble. rawStatusTail keeps the last
    // stretch of raw input regardless, so the message survives to match.
    rawStatusTail = (rawStatusTail + chunk).slice(-400);
    detectStatusMessages();

    // Balancing commands sent without $...# framing are picked up here, on
    // the same raw buffer, so "BAL : CELL03 -> CELL06" works whether or not
    // it is wrapped in a frame.
    detectPlainBalancingCommand();

    realLineBuffer += chunk;

    let startIndex;

    while ((startIndex = realLineBuffer.indexOf("$")) !== -1) {

        const endIndex = realLineBuffer.indexOf("#", startIndex);

        if (endIndex === -1) {

            // Message isn't complete yet — keep from the "$" onward
            // and wait for the rest to arrive in a later chunk.
            realLineBuffer = realLineBuffer.slice(startIndex);

            return;

        }

        const message = realLineBuffer.slice(startIndex + 1, endIndex);

        realLineBuffer = realLineBuffer.slice(endIndex + 1);

        applyRealDeviceLine(message);

    }

}

// Maps the short word used in a remote SET command to the actual
// input id in the Equalization Settings modal.
const REMOTE_FIELD_MAP = {
    EQHIGH: "eqHigh",
    EQLOW: "eqLow",
    STARTVOLTAGE: "startVoltage",
    DIFFLIMIT: "diffLimit",
    CURRENTLIMIT: "currentLimit",
    CELLS: "stringCount",
    OVPROTECTION: "ovProtection",
    OVRECOVERY: "ovRecovery",
    UVPROTECTION: "uvProtection",
    PRESSURELIMIT: "pressureLimit",
    BALON: "balanceOnTime",
    BALOFF: "balanceOffTime",
    OVERBAL: "overBalWarnLimit"
};

// The reverse of REMOTE_FIELD_MAP — given an input id, get back the
// short word Docklight/the board would recognize (e.g. "eqHigh" -> "EQHIGH").
const FIELD_KEY_BY_ID = Object.fromEntries(
    Object.entries(REMOTE_FIELD_MAP).map(([key, id]) => [id, key])
);

// Applies a remote "SET <FIELD> <VALUE>" command the same way typing
// into that field and clicking SET would — updates the input, saves
// it, and (for CELLS specifically) resizes the dashboard grid.
function applyRemoteSetting(fieldKey, rawValue) {

    const id = REMOTE_FIELD_MAP[fieldKey];

    if (!id) {

        showStatus(`⚠ Unknown Setting — ${fieldKey}`, "stop");
        logEvent(`⚠ Unknown Remote Setting — ${fieldKey}`, "error");

        return;

    }

    const input = document.getElementById(id);

    if (!input) return;

    if (id === "stringCount") {

        const value = parseInt(rawValue, 10);

        // No upper limit on the cell count — any number is accepted. The
        // floor of 1 is not a policy choice: a pack of 0 cells has no
        // highest/lowest/average to compute and would break every statistic.
        if (isNaN(value) || value < 1) {

            showStatus(`⚠ Invalid Value For CELLS — ${rawValue}`, "stop");
            logEvent(`⚠ Invalid Remote Setting — CELLS ${rawValue}`, "error");

            return;

        }

        input.value = value;

        const slider = document.getElementById(id + "Slider");
        if (slider) slider.value = value;

        // transmit=false: this setting arrived from the serial port, and
        // applyStringNumber() would otherwise send "$SET CELLS:n#" right
        // back at the sender. CELLS was the only setting that did this.
        applyStringNumber(false);

        showStatus(`⚙ CELLS Set To ${value} (Remote Command)`, "success");
        logEvent(`⚙ CELLS Set To ${value} (Remote Command)`, "success");

        sendActionLine(`SET CELLS = ${value} cells (REMOTE)`);

        return;

    }

    const value = parseFloat(rawValue);

    if (isNaN(value)) {

        showStatus(`⚠ Invalid Value For ${fieldKey} — ${rawValue}`, "stop");
        logEvent(`⚠ Invalid Remote Setting — ${fieldKey} ${rawValue}`, "error");

        return;

    }

    input.value = value;

    // Setting .value directly (vs. the user dragging it) doesn't fire
    // an "input" event, so the paired slider never hears about the
    // change on its own — move it to match explicitly.
    const slider = document.getElementById(id + "Slider");
    if (slider) slider.value = value;

    saveEqSetting(id);

    showStatus(`⚙ ${fieldKey} Set To ${value} (Remote Command)`, "success");
    logEvent(`⚙ ${fieldKey} Set To ${value} (Remote Command)`, "success");

    // Acknowledge in Docklight. Never re-send the "$SET ...#" frame —
    // only the readable line, so the sender is confirmed, not commanded.
    sendActionLine(`${describeCommand(`SET ${fieldKey}:${value}`)} (REMOTE)`);

}

// ======================================
// READ PARAMETERS
// ======================================
//
// Checks the device's Equalization Settings against this dashboard's.
// The dashboard sends "$READPARAM#"; the device (or Docklight standing in
// for it) replies with one frame listing its values, e.g.
//
//   $PARAM EQHIGH:4.000,STARTVOLTAGE:3.650,CELLS:16#
//
// Only the fields present in the reply are compared, so a partial reply is
// fine. The reply is NEVER applied to the fields — this reports agreement
// only, so a device mismatch can't silently overwrite what is on screen.

let awaitingParams = false;
let readParamTimer = null;

// A real board answers in milliseconds, but when Docklight stands in for it
// the reply is a human clicking a Send Sequence — so allow enough time for
// that rather than timing out before anyone can press the button. A late
// reply is still compared: this timeout only ends the "waiting" message.
const PARAM_REPLY_TIMEOUT_MS = 20000;

function readParameters() {

    if (!realPort || !realPort.writable) {

        showStatus("⚠ No Device Connected — Cannot Read Parameters", "stop");
        logEvent("⚠ Read Parameters — No Device Connected", "error");

        return;

    }

    awaitingParams = true;

    // A device that never answers must not leave the request hanging with
    // no outcome — say so rather than wait forever.
    clearTimeout(readParamTimer);

    readParamTimer = setTimeout(() => {

        if (!awaitingParams) return;

        awaitingParams = false;

        showStatus("⚠ No Parameter Reply — Send A $PARAM ...# Frame From Docklight", "stop");
        logEvent("⚠ Read Parameters — No Reply. The device must answer with $PARAM ...#", "error");

    }, PARAM_REPLY_TIMEOUT_MS);

    sendSerialCommand("READPARAM");

    // "success" is not a verdict here — it is simply showStatus's only
    // non-red style, and a plain "waiting…" must not look like a failure.
    showStatus("📥 Checking Values — Waiting For The Device's $PARAM Reply…", "success");
    logEvent("📥 Read Parameters Requested", "info");

}

// Compares a "$PARAM ...#" reply against the Equalization Settings fields.
// Every parameter is reported with BOTH values — the device's and the
// dashboard's — so the two can be checked side by side, in the Activity Log
// and in Docklight, rather than only being told which ones disagree.
function compareParameters(text) {

    awaitingParams = false;

    clearTimeout(readParamTimer);

    const pattern = /([A-Z]+)\s*[:=]\s*([-\d.]+)/gi;

    const results = [];
    const unknown = [];

    let match;

    while ((match = pattern.exec(text)) !== null) {

        const key = match[1].toUpperCase();

        // "PARAM" is the frame's own keyword, not a parameter.
        if (key === "PARAM") continue;

        const id = REMOTE_FIELD_MAP[key];
        const input = id ? document.getElementById(id) : null;
        const deviceValue = parseFloat(match[2]);

        if (!input || isNaN(deviceValue)) {

            unknown.push(key);

            continue;

        }

        const dashValue = parseFloat(input.value);

        // Compared as numbers with a tolerance, so "4" and "4.000" agree
        // rather than differing on formatting alone.
        const same = !isNaN(dashValue) && Math.abs(deviceValue - dashValue) <= 1e-6;

        results.push({ key, deviceValue, dashValue, same });

    }

    if (unknown.length) {

        logEvent(`⚠ Read Parameters — Ignored Unknown: ${unknown.join(", ")}`, "error");

    }

    if (!results.length) {

        showStatus("⚠ No Known Parameters In The Reply", "stop");
        logEvent("⚠ Read Parameters — No Known Parameters In The Reply", "error");

        return;

    }

    const differing = results.filter(r => r.same === false);

    const shown = value => isNaN(value) ? "(blank)" : value;

    // Every parameter, both values, in the Activity Log.
    logEvent(`📥 Value Check — Device / Dashboard (${results.length} Checked)`, "info");

    results.forEach(r => {

        logEvent(
            `${r.same ? "✅" : "⚠"} ${r.key} — Device ${r.deviceValue} / Dashboard ${shown(r.dashValue)}`,
            r.same ? "success" : "error"
        );

    });

    // The same table in Docklight, so the values can be checked there too.
    // Contains no "$" or "#", so neither parser mistakes it for a frame.
    const rule = "-".repeat(56);

    const table = [
        "",
        rule,
        "PARAMETER CHECK — DEVICE vs DASHBOARD",
        rule,
        ...results.map(r =>
            `${r.same ? " OK " : "DIFF"}  ${r.key.padEnd(13)} ` +
            `DEVICE=${String(r.deviceValue).padEnd(10)} ` +
            `DASHBOARD=${shown(r.dashValue)}`
        ),
        rule,
        differing.length
            ? `RESULT : VALUES CHANGED — ${differing.length} OF ${results.length} UPDATED ON DASHBOARD (${differing.map(d => d.key).join(", ")})`
            : `RESULT : SAME VALUES — ALL ${results.length} MATCH`,
        rule,
        ""
    ].join("\r\n");

    sendSerialText(table);

    if (!differing.length) {

        showStatus("✅ Same values", "success");
        logEvent(`✅ Same values — all ${results.length} match`, "success");

        return;

    }

    // The device is the source of truth: bring every differing dashboard
    // field into line with the device's value. Each is written into its input
    // (and its paired slider), saved, and the cell grid resized if CELLS
    // changed — exactly as a "$SET ...#" would, but quietly, without echoing
    // an ack back per field.
    differing.forEach(r => {

        const id = REMOTE_FIELD_MAP[r.key];
        const input = id ? document.getElementById(id) : null;

        if (!input) return;

        input.value = r.deviceValue;

        const slider = document.getElementById(id + "Slider");
        if (slider) slider.value = r.deviceValue;

        if (id === "stringCount") applyStringNumber(false);
        else saveEqSetting(id);

    });

    // The toast names which parameters changed; the per-value detail is in
    // the log and the Docklight table above, so the toast stays readable.
    showStatus(`⚠ Values Updated To Device — ${differing.map(d => d.key).join(", ")}`, "stop");
    logEvent(`⚠ Values Changed — ${differing.length} Of ${results.length} Updated To Device Values`, "error");

    differing.forEach(r => {

        logEvent(`   ↳ ${r.key} — Dashboard Now ${r.deviceValue} (Was ${shown(r.dashValue)})`, "info");

    });

}

// A connected real device should only ever show ITS OWN readings —
// never a leftover simulated value. Whenever a message can't be read
// as valid cell data, the cells go to 0V rather than keep showing
// whatever was there before, so a broken/missing reading is obvious
// instead of silently looking like real data.
function zeroOutCellVoltages() {

    cellVoltages = new Array(CELL_COUNT).fill(0);

}

// Pulls out every "CELLnn:####mV" reading regardless of order or
// exact unit casing, e.g. "CELL01:3500mV,CELL02:3400mV,..." — the
// number after the colon is read as millivolts and converted to volts.
function applyRealDeviceLine(message) {

    const text = message.trim();
    const cmd = text.toUpperCase();

    // Every remotely-triggered action runs with transmit=false, then
    // acknowledges with the readable line only. Letting these transmit
    // would send "$START#" straight back at whoever just sent it — an
    // echo Docklight merely displays, but a real board would obey.
    if (cmd === "START") {

        console.log("START command received");

        if (!running) startBMS(false);

        sendActionLine(`${describeCommand(cmd)} (REMOTE)`);

        return;
    }

    if (cmd === "STOP") {

        console.log("STOP command received");

        if (running) stopBMS(false);

        sendActionLine(`${describeCommand(cmd)} (REMOTE)`);

        return;
    }

    if (cmd === "BALSTART") {

        // Balancing is driven from Docklight, independently of the dashboard's
        // START button — so "$BALSTART#" starts it on its own, with no "start
        // the BMS first" requirement. startBalancing() still enforces its own
        // guards (under-voltage, already balanced, locked out, hardware fault)
        // and reports each via a toast, never a modal, so an incoming byte
        // can never pop an alert the user must dismiss.
        if (!balancingActive) startBalancing(false);

        sendActionLine(`${describeCommand(cmd)} (REMOTE)`);

        return;

    }

    if (cmd === "BALSTOP") {

        if (balancingActive) stopBalancing(false);

        sendActionLine(`${describeCommand(cmd)} (REMOTE)`);

        return;

    }

    // Docklight naming the balancing pair directly — cell 3 discharges into
    // cell 6. All of these forms are accepted, so it can be sent in the same
    // readable shape the dashboard reports it in:
    //   $BAL : CELL03 -> CELL06#
    //   $BALCELL:3,6#      $BALCELL:3->6#      $BAL:3,6#
    //   $BALCELL:3#  /  $BAL:CELL03#   -> discharge only, no receiver
    // "CELL" is optional, and the separator may be ":", "=", ",", "->" etc.
    const balCellMatch = cmd.match(
        /^BAL\s*[:=]?\s*(?:CELL\s*[:=]?\s*)?(\d+)(?:\s*[-,>]+\s*(?:CELL\s*[:=]?\s*)?(\d+))?$/
    );

    if (balCellMatch) {

        setManualBalancePair(
            parseInt(balCellMatch[1], 10) - 1,
            balCellMatch[2] !== undefined ? parseInt(balCellMatch[2], 10) - 1 : -1
        );

        return;

    }

    if (cmd === "CURRENTZERO") {

        currentZero(false);

        sendActionLine(`${describeCommand(cmd)} (REMOTE)`);

        return;

    }

    if (cmd === "AUTOEQUALIZE") {

        autoEqualization(false);

        sendActionLine(`${describeCommand(cmd)} (REMOTE)`);

        return;

    }

    if (cmd === "RESTART") {

        logEvent("↻ System Restarting (Remote Command)", "info");

        location.reload();

        return;

    }

    // "$PARAM EQHIGH:4.000,CELLS:16#" — the device reporting its own
    // settings in reply to READPARAM. Compared against the dashboard and
    // reported on; deliberately never applied to the fields.
    if (/^PARAM\b/.test(cmd)) {

        compareParameters(cmd);

        return;

    }

    // "SET <FIELD> <VALUE>" — accepts a space, colon, or "=" between
    // the field name and value (and no space after "SET" either), so
    // "$SET EQHIGH 4.000#", "$SET EQHIGH:4.000#" and "$SETEQHIGH:4.000#"
    // all work the same.
    const setMatch = cmd.match(/^SET\s*([A-Z]+)\s*[:=]?\s*([\d.]+)$/);

    if (setMatch) {

        applyRemoteSetting(setMatch[1], setMatch[2]);

        return;

    }

    if (!text) return;

    const cellPattern = /CELL\s*(\d+)\s*:\s*([\d.]+)/gi;

    const readings = {};
    const outOfRange = [];
    let match;

    while ((match = cellPattern.exec(text)) !== null) {

        const index = parseInt(match[1], 10) - 1;
        const volts = parseFloat(match[2]) / 1000;

        // Every voltage is accepted — there is deliberately no upper sanity
        // limit, so any reading the device sends is shown as-is rather than
        // being second-guessed. Only an unreadable number or a bad cell
        // index is skipped, since neither can be stored anywhere.
        if (index < 0 || isNaN(volts)) continue;

        // Incoming data NEVER changes how many cells exist — the pack size is
        // String Number's job alone. A cell number past the configured count
        // is a typo or a corrupt frame ("CELL089" for "CELL09"), and growing
        // the grid to fit it would bury the real cells under dozens of empty
        // ones. Drop the reading instead.
        if (index >= CELL_COUNT) {

            outOfRange.push(index + 1);

            continue;

        }

        readings[index] = volts;

    }

    if (outOfRange.length) {

        console.log(
            `Ignored cell number(s) beyond String Number (${CELL_COUNT}):`,
            outOfRange.join(", "), "in:", message
        );

    }

    const indices = Object.keys(readings).map(Number);

    if (!indices.length) {

        // No usable CELLnn:#### reading in this line — a corrupt/partial
        // frame (serial overrun fragments frames constantly). Keep the last
        // good readings rather than blanking every cell to 0V, which would
        // read as "disconnected".
        console.log("Ignored unrecognized line from device:", message);

        return;

    }

    // Cells may arrive one-per-line — each its own "$CELLnn:####mV#" frame,
    // written line by line in Docklight — OR all together in a single frame.
    // So MERGE each reading into the live array by its cell index instead of
    // demanding the whole pack at once.

    // Clear simulated drift before assigning (never after, or it would wipe
    // the very readings that triggered it).
    disableSimulationForRealData();

    const updated = cellVoltages.slice();

    indices.forEach(i => { updated[i] = readings[i]; });

    cellVoltages = updated;

    lastCellFrameAt = Date.now();

}

async function disconnectRealDevice() {

    if (realReader) await realReader.cancel().catch(() => {});

    if (realPort) await realPort.close().catch(() => {});

    realPort = null;

    setDeviceStatus(false);

    // The last readings the board sent are now stale, and nothing will
    // overwrite them — the random walk does not run once real data has
    // arrived. Left alone they would sit on screen looking like a live
    // battery. If we were only ever simulating (the port led to
    // Docklight, say), there is nothing real to invalidate, and zeroing
    // would make the walk clamp 0V straight up to its 3.0V floor.
    if (!simulationEnabled) zeroOutCellVoltages();

}

if ("serial" in navigator) {

    navigator.serial.addEventListener("disconnect", () => {

        if (realDeviceConnected) disconnectRealDevice();

    });

}

// ------------------------------
// DATA LOGGING (File System Access API)
// ------------------------------

let logDirHandle = null;
let logFileHandle = null;
let logBytePosition = 0;
let currentLogDate = null;
let currentLogDataSource = null;
let logQueue = Promise.resolve();

// Real hardware readings and Automatic Values must never end up in
// the same file — this decides which one today's rows belong in.
//
// Keyed on whether the numbers were invented, not on whether the board
// happens to be connected right now. Otherwise a real-device session
// that loses its USB lead would file its own disconnect message — and
// any rows still in flight — under Automatic, which never ran.
function currentDataSourceLabel() {

    return simulationEnabled ? "Automatic" : "Real";

}

// The cell count the currently-open file's most recent header was
// written for. If String Number changes CELL_COUNT afterwards, every
// row from then on would have a different column count than that
// fixed header — so a fresh header gets re-emitted whenever this
// drifts out of sync, instead of silently misaligning columns.
let loggedCellCount = null;

function csvRow(values) {

    return values.join(",") + "\n";

}

function buildHeaderRow() {

    return csvRow([
        "Date", "Time",
        ...Array.from({ length: CELL_COUNT }, (_, i) => `Cell${i + 1}(V)`),
        "TotalVoltage(V)", "Current(A)", "Power(W)",
        "MaxCell", "MaxVoltage(V)", "MinCell", "MinVoltage(V)",
        "AvgVoltage(V)", "Difference(V)", "CapacityUsed(%)"
    ]);

}

// Excel auto-detects date/time-shaped text and silently converts it
// to its own date serial number (shown right-aligned, reformatted to
// the system locale). Wrapping the value as a formula that evaluates
// to a literal string forces Excel to keep it as plain text instead.
function asCsvText(value) {

    return `="${value}"`;

}

function byteLength(text) {

    return new TextEncoder().encode(text).length;

}

function todayDateStr() {

    const now = new Date();

    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");

    return `${y}-${m}-${d}`;

}

function csvTimeStr() {

    const now = new Date();

    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");

    return `${hh}:${mm}:${ss}`;

}

// ------------------------------
// REMEMBER THE CHOSEN FOLDER ACROSS EVERY RUN
// (IndexedDB, since a FileSystemDirectoryHandle
// can't be stored in localStorage but can here)
// ------------------------------

const LOG_DB_NAME = "bmsLogDB";
const LOG_STORE_NAME = "handles";
const LOG_HANDLE_KEY = "logDirHandle";

function openHandleDB() {

    return new Promise((resolve, reject) => {

        const request = indexedDB.open(LOG_DB_NAME, 1);

        request.onupgradeneeded = () => {
            request.result.createObjectStore(LOG_STORE_NAME);
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);

    });

}

async function saveHandleToDB(handle) {

    const db = await openHandleDB();

    return new Promise((resolve, reject) => {

        const tx = db.transaction(LOG_STORE_NAME, "readwrite");

        tx.objectStore(LOG_STORE_NAME).put(handle, LOG_HANDLE_KEY);

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);

    });

}

async function loadHandleFromDB() {

    const db = await openHandleDB();

    return new Promise((resolve, reject) => {

        const tx = db.transaction(LOG_STORE_NAME, "readonly");

        const request = tx.objectStore(LOG_STORE_NAME).get(LOG_HANDLE_KEY);

        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);

    });

}

// Resolves the ONE folder used for the lifetime of this app — picked
// once, ever, then reused on every future run, no matter how many
// times the BMS is started/stopped or the page is reloaded.
async function ensureLogDir() {

    if (logDirHandle) return true;

    if (!("showDirectoryPicker" in window)) {

        alert("Your browser does not support choosing a folder.\nPlease use Google Chrome or Microsoft Edge.");

        return false;

    }

    try {

        const savedDir = await loadHandleFromDB().catch(() => null);

        if (savedDir) {

            let permission = await savedDir.queryPermission({ mode: "readwrite" });

            if (permission !== "granted") {

                permission = await savedDir.requestPermission({ mode: "readwrite" });

            }

            if (permission === "granted") {

                logDirHandle = savedDir;

                return true;

            }

        }

        // First time ever (or permission was lost) — ask once and
        // remember the folder for every run from now on.
        logDirHandle = await window.showDirectoryPicker({ mode: "readwrite" });

        await saveHandleToDB(logDirHandle);

        return true;

    }

    catch (error) {

        console.log(error);

        logDirHandle = null;

        if (error.name !== "AbortError") {

            showStatus("⚠ Could Not Access Log Folder — " + error.message, "stop");

            logEvent("⚠ Could Not Access Log Folder — " + error.message, "error");

        }

        return false;

    }

}

// Lets you pick a different folder to save the CSV logs in. This asks
// RIGHT NOW where to store (the button click is the user gesture the
// folder picker needs), forgets the old folder, and opens today's file
// in the new one so rows start saving immediately.
async function resetLogFolder() {

    if (!("showDirectoryPicker" in window)) {

        alert("Your browser does not support choosing a folder.\nPlease use Google Chrome or Microsoft Edge.");

        return;

    }

    // Forget whatever was remembered before.
    logDirHandle = null;
    logFileHandle = null;
    currentLogDate = null;
    currentLogDataSource = null;

    try {

        const db = await openHandleDB();

        await new Promise((resolve, reject) => {

            const tx = db.transaction(LOG_STORE_NAME, "readwrite");

            tx.objectStore(LOG_STORE_NAME).delete(LOG_HANDLE_KEY);

            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);

        });

    }

    catch (error) { console.log(error); }

    try {

        // Ask where to store — this is the whole point of the button.
        logDirHandle = await window.showDirectoryPicker({ mode: "readwrite" });

        await saveHandleToDB(logDirHandle);

        // Open (or create) today's file straight away so logging begins now,
        // without waiting for the next Start.
        await openTodayLogFile();

        showStatus("📁 Log Folder Selected — Data Will Be Saved Here", "success");

        logEvent("📁 Log Folder Selected — Logging Enabled", "success");

    }

    catch (error) {

        console.log(error);

        logDirHandle = null;

        // Cancelling the picker is not an error worth shouting about.
        if (error.name !== "AbortError") {

            showStatus("⚠ Could Not Set Log Folder — " + error.message, "stop");

            logEvent("⚠ Could Not Set Log Folder — " + error.message, "error");

        }

    }

}

// Opens the log file WITHOUT ever popping the folder picker — it only
// reuses a folder chosen earlier (restoring it from storage and, if this
// runs from a click, re-granting permission). Picking a brand-new folder
// is done explicitly via the Change Log Folder button. Safe to call on
// every Start; it no-ops once the file is already open.
async function ensureLogFileQuiet() {

    if (logFileHandle) return true;

    if (!logDirHandle) {

        if (!("showDirectoryPicker" in window)) return false;

        const savedDir = await loadHandleFromDB().catch(() => null);

        if (!savedDir) return false;

        let permission = await savedDir.queryPermission({ mode: "readwrite" });

        if (permission !== "granted") {

            permission = await savedDir.requestPermission({ mode: "readwrite" }).catch(() => "denied");

        }

        if (permission !== "granted") return false;

        logDirHandle = savedDir;

    }

    return await openTodayLogFile();

}

// On page load, silently restore a previously chosen folder (only if its
// permission is still granted — requesting it needs a user gesture) and
// open today's file, so logging resumes on its own after a reload.
async function initLogging() {

    if (logDirHandle || !("showDirectoryPicker" in window)) return;

    try {

        const savedDir = await loadHandleFromDB().catch(() => null);

        if (!savedDir) return;

        const permission = await savedDir.queryPermission({ mode: "readwrite" });

        if (permission === "granted") {

            logDirHandle = savedDir;

            await openTodayLogFile();

            logEvent("📁 Log Folder Restored — Logging Enabled", "info");

        }

    }

    catch (error) { console.log(error); }

}

document.addEventListener("DOMContentLoaded", initLogging);

// Opens (or creates) today's CSV file inside the chosen folder. If a
// session is still running when the date rolls over, this switches to
// a fresh file for the new day automatically.
async function openTodayLogFile() {

    const dateStr = todayDateStr();
    const source = currentDataSourceLabel();

    if (logFileHandle && currentLogDate === dateStr && currentLogDataSource === source) return true;

    const fileName = `BMS_Log_${source}_${dateStr}.csv`;

    try {

        let fileHandle;
        let isNewFile = false;

        try {

            fileHandle = await logDirHandle.getFileHandle(fileName, { create: false });

        }

        catch {

            fileHandle = await logDirHandle.getFileHandle(fileName, { create: true });
            isNewFile = true;

        }

        logFileHandle = fileHandle;
        currentLogDate = dateStr;
        currentLogDataSource = source;

        const existing = await logFileHandle.getFile();

        if (isNewFile || existing.size === 0) {

            const header = buildHeaderRow();

            // Write and immediately commit the header so the file is
            // never left "open" (File System Access API only makes
            // writes visible on disk once the writable stream is closed).
            const writable = await logFileHandle.createWritable();

            await writable.write(header);
            await writable.close();

            logBytePosition = byteLength(header);
            loggedCellCount = CELL_COUNT;

        } else {

            // Resume appending from the file's real current size, so
            // nothing already logged earlier today is overwritten.
            logBytePosition = existing.size;

            // We don't know what cell count the existing rows on disk
            // were written with (could be from an earlier browser
            // session) — force a fresh header on the next row so
            // column alignment is always correct going forward.
            loggedCellCount = null;

        }

        return true;

    }

    catch (error) {

        console.log(error);

        logFileHandle = null;

        showStatus("⚠ Could Not Open Today's Log File — " + error.message, "stop");

        logEvent("⚠ Could Not Open Today's Log File — " + error.message, "error");

        return false;

    }

}

async function ensureLogFile() {

    const dirReady = await ensureLogDir();

    if (!dirReady) return false;

    return await openTodayLogFile();

}

// If one write in the queue ever fails, the chain becomes a
// permanently rejected promise — every future .then() on it would
// silently skip forever, so no row would ever write again for the
// rest of the session. Catching here and resetting the queue means
// a single hiccup can't take down all future logging.
function handleLogFailure(error) {

    console.log(error);

    logQueue = Promise.resolve();

    showStatus("⚠ A Log Write Failed — " + error.message, "stop");

    logEvent("⚠ A Log Write Failed — " + error.message, "error");

}

function logRow(row) {

    if (!logFileHandle) return;

    // If the calendar day changed, or the data source changed (real
    // device vs Automatic Values), roll over to the right file before
    // writing the next row — the two sources must never share a file.
    if (currentLogDate !== todayDateStr() || currentLogDataSource !== currentDataSourceLabel()) {

        logQueue = logQueue
            .then(() => openTodayLogFile())
            .then(() => appendRowToDisk(csvRow(row)))
            .catch(handleLogFailure);

        return;

    }

    // String Number changed CELL_COUNT since the last header was
    // written — re-announce a fresh header (with a blank line first
    // so it's visually obvious in the file) so column counts line up
    // with every row from here on, instead of silently drifting.
    // Written as a single combined chunk (not two separate writes)
    // so this can't partially fail, and the flag flips immediately
    // (not inside a queued .then()) so a second call can't double up.
    if (loggedCellCount !== CELL_COUNT) {

        const combined = "\n" + buildHeaderRow() + csvRow(row);

        loggedCellCount = CELL_COUNT;

        logQueue = logQueue
            .then(() => appendRowToDisk(combined))
            .catch(handleLogFailure);

        return;

    }

    logQueue = logQueue
        .then(() => appendRowToDisk(csvRow(row)))
        .catch(handleLogFailure);

}

async function writeChunkAtPosition(text) {

    const writable = await logFileHandle.createWritable({ keepExistingData: true });

    await writable.write({ type: "write", position: logBytePosition, data: text });

    await writable.close();

    logBytePosition += byteLength(text);

}

function wait(ms) {

    return new Promise(resolve => setTimeout(resolve, ms));

}

async function appendRowToDisk(text) {

    // The cached file state can go stale if something else (Excel
    // having the file open, OneDrive syncing it, antivirus scanning
    // it, etc.) touches it at the same moment. These locks are
    // usually brief, so retry a couple of times with a short pause —
    // an instant retry often still collides with the same lock.
    const attempts = 3;

    for (let attempt = 1; attempt <= attempts; attempt++) {

        try {

            await writeChunkAtPosition(text);

            return;

        }

        catch (error) {

            console.log(`Log write attempt ${attempt} failed:`, error);

            if (attempt === attempts) throw error;

            await wait(400 * attempt);

            const file = await logFileHandle.getFile();

            logBytePosition = file.size;

        }

    }

}

// ------------------------------
// USER DETAILS
// ------------------------------

// ------------------------------
// PERSIST EQUALIZATION SETTINGS
// (localStorage — survives page reloads)
// ------------------------------

const EQ_SETTING_IDS = [
    "eqHigh", "eqLow", "startVoltage", "diffLimit", "currentLimit",
    "stringCount", "ovProtection", "ovRecovery", "uvProtection", "pressureLimit",
    "balanceOnTime", "balanceOffTime", "overBalWarnLimit"
];

// The charge/discharge count at which a cell is flagged as over-balancing.
// Set in Equalization Settings; defaults to 10.
function overBalWarnLimit() {

    const v = parseInt(document.getElementById("overBalWarnLimit")?.value, 10);
    return !isNaN(v) && v > 0 ? v : 10;

}

function saveEqSetting(id) {

    const input = document.getElementById(id);

    if (input) localStorage.setItem(`eqSetting_${id}`, input.value);

    // These inputs the balance projection is built from, so changing any
    // invalidates it. Every path that changes a setting — the SET buttons,
    // a remote "$SET ...#", the cell-count field — funnels through here, so
    // this is the one place that needs to know.
    if (balancingActive &&
        (id === "currentLimit" || id === "startVoltage" ||
         id === "balanceOnTime" || id === "balanceOffTime")) {

        resetBalanceEstimate();

    }

}

// The SAVE button at the foot of Equalization Settings: persists every
// field at once (so values typed without pressing each card's SET are not
// lost on reload) and reports "SAVE OK" to Docklight.
function saveAllSettings() {

    EQ_SETTING_IDS.forEach(id => saveEqSetting(id));

    showStatus("💾 Settings Saved", "success");

    logEvent("💾 Equalization Settings Saved", "success");

    // Sends "$SAVE#" plus the readable ">> SAVE OK" line Docklight shows.
    sendSerialCommand("SAVE");

}

function loadEqSettings() {

    EQ_SETTING_IDS.forEach(id => {

        const saved = localStorage.getItem(`eqSetting_${id}`);

        if (saved === null) return;

        const input = document.getElementById(id);

        if (input) input.value = saved;

    });

    // String Number also has to resize the actual dashboard grid, not
    // just the input field, so it matches what was saved before reload.
    const count = parseInt(document.getElementById("stringCount").value, 10);

    if (!isNaN(count) && count >= 1 && count !== CELL_COUNT) {

        CELL_COUNT = count;

        cellVoltages = new Array(CELL_COUNT).fill(0);
        cellOVFault = new Array(CELL_COUNT).fill(false);
        cellUVFault = new Array(CELL_COUNT).fill(false);
        cellBalancing = new Array(CELL_COUNT).fill(false);
        cellCharging = new Array(CELL_COUNT).fill(false);
        cellDischargeCount = new Array(CELL_COUNT).fill(0);
        cellChargeCount = new Array(CELL_COUNT).fill(0);
        cellDischargedThisCycle = new Array(CELL_COUNT).fill(false);
        cellChargedThisCycle = new Array(CELL_COUNT).fill(false);

    }

}

window.addEventListener("DOMContentLoaded", () => {

    const user = JSON.parse(sessionStorage.getItem("currentUser"));

    if (user) {

        document.getElementById("profileName").innerHTML =
            user.fullname;

    }

    loadEqSettings();

    renderActivityLog();

    createCells();
    updateFooterClock();
    setInterval(updateFooterClock, 1000);

    // Restore today's running balancing tally before the first render, so
    // a mid-day reload shows the accumulated counts rather than zeros.
    // After loadEqSettings() above, so CELL_COUNT is already correct.
    loadBalanceStatsForToday();
    updateBalancingCycleStat();

    // A daily lockout restored from storage must show on the button too,
    // not only in the tile — otherwise it looks clickable but refuses.
    if (balancingLockedOut) {

        const btn = document.getElementById("balStartBtn");

        if (btn) btn.disabled = true;

    }

    // Live cell telemetry — starts immediately on page load and keeps
    // running forever, whether the BMS session is started or stopped.
    initCellVoltages();

    // A refresh must not blank the pack: bring back the last real readings
    // saved before reload, so the cells keep showing their values until the
    // board sends its next frame.
    restoreCellSnapshot();

    renderCells();
    updateStats(false);

    setInterval(liveDataTick, TICK_MS);

    // If the BMS device was already granted permission (e.g. the one
    // connected at login), pick it back up automatically here — the
    // user shouldn't have to click "Connect Real Device" a second
    // time for the same physical device.
    autoConnectRealDevice();

});

// ======================================
// CREATE 16 BATTERY CELLS
// ======================================

function createCells() {

    const container = document.getElementById("cells");

    container.innerHTML = "";

    for (let i = 1; i <= CELL_COUNT; i++) {

        const color = CELL_COLORS[(i - 1) % CELL_COLORS.length];

        const div = document.createElement("div");

        div.className = "cell";
        div.id = `cellCard${i}`;
        div.style.setProperty("--c", color);

        div.innerHTML = `

            <div class="cell-badge" id="cellBadge${i}"></div>

            <span class="cell-chip">Cell ${i}</span>

            <div class="cell-gauge" id="cellGauge${i}">
                <div class="cell-gauge-inner">
                    <span class="cell-voltage" id="cellVal${i}">0.000 V</span>
                </div>
            </div>

            <div class="cell-msgs" id="cellMsg${i}"></div>

            <div class="cell-counts" id="cellCount${i}">
                <span class="count-discharge" title="Times this cell has discharged">▼ 0</span>
                <span class="count-charge" title="Times this cell has charged">▲ 0</span>
            </div>

        `;

        container.appendChild(div);

    }

}

// ======================================
// RANDOM HELPER
// ======================================

function randomInRange(min, max) {

    return Math.random() * (max - min) + min;

}

// ======================================
// SHOW STATUS
// ======================================

// Each call adds a new toast UNDER the previous ones instead of
// replacing the last message in place, so a burst of events (START,
// Balancing Started, ...) reads as a short stacked list rather than one
// line that flickers between them. Every toast removes itself after a
// few seconds, youngest at the bottom.
function showStatus(message, type) {

    const container = document.getElementById("systemStatus");

    if (!container) return;

    const toast = document.createElement("div");

    toast.className = "status-toast " + (type === "success" ? "status-success" : "status-stop");

    toast.innerHTML = message;

    container.appendChild(toast);

    // Never let a flood of events grow the stack without bound; drop the
    // oldest once there are more than a handful on screen.
    while (container.children.length > 5) {

        container.removeChild(container.firstChild);

    }

    setTimeout(() => {

        toast.classList.add("status-out");

        setTimeout(() => toast.remove(), 300);

    }, 3000);

}

// ======================================
// START BMS
// ======================================
// ======================================
// SEND COMMAND TO DEVICE / DOCKLIGHT
// ======================================

// Writes run one at a time. getWriter() throws if the stream is
// already locked, and the periodic balance report can land in the
// middle of a command send — so every write goes through this chain
// instead of grabbing the writer directly. A failed write is caught
// here so one error can't poison the chain for every later write.
let serialWriteChain = Promise.resolve();

function sendSerialText(text) {

    serialWriteChain = serialWriteChain.then(async () => {

        if (!realPort || !realPort.writable) return;

        try {

            const writer = realPort.writable.getWriter();

            try {

                await writer.write(new TextEncoder().encode(text));

            }

            finally {

                writer.releaseLock();

            }

        }

        catch (error) {

            console.log(error);

        }

    });

    return serialWriteChain;

}

// Plain-English name for each action, so Docklight shows what the
// operator did rather than only the terse "$BALSTART#" wire frame.
const ACTION_LABELS = {
    START: "BMS START",
    STOP: "BMS STOP",
    BALSTART: "BALANCING START",
    BALSTOP: "BALANCING STOP",
    CURRENTZERO: "CURRENT ZERO",
    AUTOEQUALIZE: "AUTOMATIC EQUALIZATION",
    RESTART: "SYSTEM RESTART",
    SAVE: "SAVE OK",
    READPARAM: "READ PARAMETERS"
};

// Units are taken from the labels the Equalization Settings modal
// already shows next to each field — not invented here.
const SETTING_UNITS = {
    EQHIGH: "V",
    EQLOW: "V",
    STARTVOLTAGE: "V",
    DIFFLIMIT: "V",
    CURRENTLIMIT: "A",
    CELLS: "cells",
    OVPROTECTION: "V",
    OVRECOVERY: "V",
    UVPROTECTION: "V",
    PRESSURELIMIT: "kPa",
    BALON: "s",
    BALOFF: "s",
    OVERBAL: "count"
};

// "BALSTART" -> "BALANCING START", "SET EQHIGH:4.000" -> "SET EQHIGH = 4.000 V"
function describeCommand(command) {

    const upper = command.trim().toUpperCase();

    if (ACTION_LABELS[upper]) return ACTION_LABELS[upper];

    const setMatch = upper.match(/^SET\s*([A-Z]+)\s*[:=]?\s*(.+)$/);

    if (setMatch) {

        const field = setMatch[1];
        const value = setMatch[2].trim();
        const unit = SETTING_UNITS[field];

        return `SET ${field} = ${value}${unit ? " " + unit : ""}`;

    }

    // Unrecognized command — still echo it rather than printing nothing.
    return upper;

}

// The readable line only. Deliberately contains no "$" or "#", so
// neither the board's parser nor this dashboard's own receive loop
// (both of which key on the $...# frame) ever mistakes it for a command.
function sendActionLine(description) {

    return sendSerialText(`\r\n>> ${description}\r\n`);

}

// Sends the machine-readable frame the board parses, followed by the
// human-readable line the operator reads in Docklight.
async function sendSerialCommand(command) {

    if (!realPort || !realPort.writable) return;

    await sendSerialText(`$${command}#`);

    await sendActionLine(describeCommand(command));

    console.log(command + " sent");

}

// Cells are numbered the same way the board sends them: the frame
// "$CELL01:3500mV,...#" parses CELL01 into cellVoltages[0], so the
// label for index i is always i + 1. MAX/MIN/BAL all use that one
// numbering, so nothing here is off by one against the cell list.
function cellLabel(index) {

    return "C" + String(index + 1).padStart(2, "0");

}

function toMillivolts(volts) {

    return Math.round(volts * 1000);

}

// The cell discharging right now: the single highest, and only if it is
// actually above the Equalizing Starting Voltage. Returned as an array
// so callers can treat "nothing is balancing" as an empty list.
//
// Balancing runs between exactly two cells — this one discharging into
// the one chargingCellIndex() picks. Never more than two.
//
// This is the single source of truth. The transfer drains this cell, the
// grid highlights it, the box under the buttons names it, and Docklight
// reports it — so all four always agree.
//
// The discharger rotates on its own. It floors at the start voltage,
// drops out of this list, and the next-highest cell takes over on the
// following tick.
function balancingCellIndices() {

    if (!balancingActive) return [];

    // Docklight named the pair — use its discharging cell.
    if (manualBalancePair) return [manualBalancePair.sender];

    // On a REAL device the balancing pair is selected ONLY from Docklight
    // ($BALCELL). The dashboard never auto-picks cells for a real board — so
    // pressing START does not choose a pair; it waits for $BALCELL. (In
    // simulation / Remote Monitor the dashboard IS the board, so it still
    // auto-picks highest→lowest below.)
    if (!simulationEnabled) return [];

    if (cellVoltages.length < 2) return [];

    const startVoltage = parseFloat(document.getElementById("startVoltage").value);

    if (isNaN(startVoltage)) return [];

    const highestIndex = cellVoltages.indexOf(Math.max(...cellVoltages));

    return cellVoltages[highestIndex] > startVoltage ? [highestIndex] : [];

}

// Every cell's live voltage, then MAX / MIN / DIFF, then which cells
// are discharging and which is charging. Sent each tick, so the values
// in Docklight move as the balance progresses.
// Returns null when there is nothing meaningful to report.
function formatBalanceReport() {

    if (cellVoltages.length < 2) return null;

    if (Math.max(...cellVoltages) <= 0) return null;

    // The full cell-voltage list and the MAX/MIN/DIFF summary are
    // intentionally NOT sent to Docklight — only the live balancing
    // transfer (which cell is discharging into which) is reported.
    const discharging = balancingCellIndices();

    const rule = "-".repeat(56);

    // Before START (or after STOP, or with no cell selected yet) nothing is
    // discharging — report "BAL : IDLE", with NO cell number. The cell only
    // shows once balancing is actually running on a selected cell.
    if (!discharging.length) {

        return [rule, "BAL : IDLE", rule].join("\r\n") + "\r\n";

    }

    const lines = [rule];

    const sender = discharging[0];

    const receiver = chargingCellIndex(discharging);

    // Full "CELLnn" labels, matching the "$CELLnn:####mV#" frames the device
    // sends — e.g. "BAL : CELL03 -> CELL06". The per-cell DISCHARGING /
    // CHARGING voltage lines and the "EST : COMPLETES AT" line are deliberately
    // not sent. No receiver means the low cell is already full and the
    // sender's charge is being dissipated instead.
    const cellName = index => "CELL" + String(index + 1).padStart(2, "0");

    lines.push(
        receiver === -1
            ? `BAL : ${cellName(sender)}`
            : `BAL : ${cellName(sender)} -> ${cellName(receiver)}`
    );

    lines.push(rule);

    // Docklight expects CRLF to break the line, not a bare LF.
    return lines.join("\r\n") + "\r\n";

}

let lastBalanceReportAt = 0;

function sendBalanceReport() {

    if (!realPort || !realPort.writable) return;

    // On the real-device path the board is already streaming cell data IN,
    // so echoing a full report back every tick overruns the port. Throttle
    // it to once every 2 seconds — often enough to watch in Docklight, slow
    // enough to keep the port from saturating. In simulation the dashboard
    // IS the source, so it streams every tick.
    if (!simulationEnabled) {

        const now = Date.now();

        if (now - lastBalanceReportAt < 2000) return;

        lastBalanceReportAt = now;

    }

    const report = formatBalanceReport();

    if (report) sendSerialText(report);

}
// transmit=false when this action came in *from* the serial port —
// re-sending the frame would command the board to do what it just told
// us it did. Every remotely-triggered action passes false; only a click
// on the dashboard transmits.
async function startBMS(transmit = true) {

    if (running) return;

    // An under-voltage cell blocks the whole session, not just balancing:
    // START drives the balancer, and balancing drains the highest cell into
    // the lowest — which would pull charge toward a cell already below its
    // safe limit. Refuse here, before anything starts, so the fault has to
    // be cleared first.
    const under = underVoltageCells();

    if (under.length) {

        showStatus(`⛔ Cannot Start — Under-Voltage On Cell ${under.join(", ")}`, "stop");
        logEvent(`⛔ START Refused — Under-Voltage On Cell ${under.join(", ")}`, "error");

        return;

    }

    // START drives the balancer, and the balancer moves charge using the
    // Equalizing Current. At 0 A there is nothing to run — refuse the whole
    // session here so it never even shows "BMS RUNNING…", rather than starting
    // the session and only silently skipping the balance.
    const eqCurrent = parseFloat(document.getElementById("currentLimit").value);

    if (isNaN(eqCurrent) || eqCurrent <= 0) {

        showStatus("⛔ Cannot Start — Equalizing Current Is 0 (Set A Current First)", "stop");
        logEvent("⛔ START Refused — Equalizing Current Is 0", "error");

        return;

    }

    // START no longer touches the log folder at all — the folder picker /
    // permission dialog it used to open was stalling the whole session
    // (RUNNING TIME stuck at 00:00:00, balancing refusing). Logging is now
    // opt-in: set the folder once via the RESET LOG FOLDER button, and
    // rows write from then on. START must always start the session.

    running = true;

    document.getElementById("startBtn").disabled = true;
    document.getElementById("stopBtn").disabled = false;
    document.getElementById("startBtn").classList.add("running");

    document.getElementById("spinner").style.display = "block";
    document.getElementById("runningLabel").style.display = "block";

    showStatus("🟢 START", "success");

    logEvent("▶ START Command Sent", "success");

    // Make sure this session's rows are saved. Non-blocking so the timer
    // starts instantly: if a log folder was chosen before, this opens
    // today's file (using this click to re-grant permission if needed).
    // If no folder was ever chosen, use the Change Log Folder button.
    ensureLogFileQuiet();

    updateStats(true);

    // Each Start begins a fresh session — the timer should always count
    // up from zero, not continue from a previous run.
    seconds = 0;

    // The cycle and per-cell counts do NOT reset here: they accumulate
    // for the whole day. Only roll them over if START is the first action
    // after midnight.
    rollBalanceStatsIfNewDay();

    // The per-CYCLE participation flags, though, are exactly that — they
    // must be clear before startBalancing() below opens a new cycle.
    cellDischargedThisCycle = new Array(CELL_COUNT).fill(false);
    cellChargedThisCycle = new Array(CELL_COUNT).fill(false);

    // Clear any stale per-cell balancing lockout so a fresh session isn't
    // blocked by a leftover flag. The per-cell counts are NOT reset here —
    // they accumulate across the day toward the over-balance warning limit.
    balancingLockedOut = false;
    saveBalanceStats();

    updateBalancingCycleStat();

    document.getElementById("timer").innerHTML = "00:00:00";

    timer = setInterval(updateTimer, 1000);

    if (transmit) await sendSerialCommand("START");

    // START also starts balancing (there is no separate balancing button).
    // STOP stops it — see stopBMS below.
    if (!balancingActive) await startBalancing(transmit);

}

// ======================================
// STOP BMS
// ======================================

async function stopBMS(transmit = true) {

    if (!running) return;

    running = false;

    clearInterval(timer);

    document.getElementById("startBtn").disabled = false;
    document.getElementById("stopBtn").disabled = true;
    document.getElementById("startBtn").classList.remove("running");

    document.getElementById("spinner").style.display = "none";
    document.getElementById("runningLabel").style.display = "none";

   showStatus("🔴 STOP", "stop");

   logEvent("■ STOP Command Sent", "info");

    if (transmit) await sendSerialCommand("STOP");

    // Stopping the BMS must not leave the balancer running on the board,
    // nor the balancing box on screen describing cells nothing is acting on.
    if (balancingActive) await stopBalancing(transmit);

}

// ======================================
// LIVE CELL TELEMETRY
// (always running — never stops, even
// when the BMS session itself is stopped)
// ======================================

// True when the user explicitly chose "Use Automatic Values" at login.
// Distinct from simulationEnabled below: this is the user's stated
// intent, that is what the dashboard is actually doing right now.
function usingAutomaticValues() {

    return sessionStorage.getItem("useAutomaticData") === "true";

}

// The single answer to "may the dashboard invent cell voltages?".
//
// Off unless the user explicitly asked for Automatic Values at login.
// The real-device path NEVER simulates: a board that is missing, silent,
// or still connecting reads 0.000 V, because a plausible-looking number
// that cannot be told apart from a measurement is worse than no number.
//
// When it IS on, it is turned off for good the moment the first real
// "$CELL01:...#" frame is parsed — keyed on data actually arriving, not
// on a port being open, since an open port may lead to Docklight, which
// sends no cell data at all. It stays off if that board later
// disconnects: a dropped board reads 0.000 V, it does not resurrect as a
// plausible battery.
//
// Every simulated value on screen is labelled "Simulated Data" in the
// status bar. Nothing invented is ever presented as a measurement.
let simulationEnabled = usingAutomaticValues();

function disableSimulationForRealData() {

    if (!simulationEnabled) return;

    simulationEnabled = false;

    // Whatever the random walk had drifted to is not this board's data.
    zeroOutCellVoltages();

    setDeviceStatus(realDeviceConnected);

    showStatus("🔌 Real Cell Data Received — Simulation Off", "success");
    logEvent("🔌 Real Cell Data Received — Simulation Off", "success");

}

function initCellVoltages() {

    for (let i = 0; i < CELL_COUNT; i++) {

        cellVoltages[i] = simulationEnabled
            ? randomInRange(3.55, 3.85)
            : 0;

    }

}

function liveDataTick() {

    // Reset the day's balancing tally if the clock has crossed midnight
    // while the page stayed open. Cheap: a string compare until it does.
    rollBalanceStatsIfNewDay();

    // Real cell frames feed cellVoltages directly (see the serial read
    // loop) and switch simulationEnabled off permanently. Until then the
    // dashboard simulates, whether or not a port is open — so a COM link
    // to Docklight still shows, and transmits, live moving values.
    //
    // The walk is suspended for the whole balance. Its ±10mV of drift
    // per tick dwarfs the ~1mV the balancer moves at 0.5A, so leaving it
    // running would both bury the transfer and keep lifting fresh cells
    // back above the start voltage — the pack would be un-balanced as
    // fast as it was balanced, and the estimated finish time could never
    // be met. Cells under an active balancer are being driven, not
    // drifting.
    if (simulationEnabled && !balancingActive) {

        for (let i = 0; i < CELL_COUNT; i++) {

            let v = cellVoltages[i] + randomInRange(-0.01, 0.01);

            v = Math.min(4.0, Math.max(3.0, v));

            cellVoltages[i] = v;

        }

    }

    applyActiveBalancing();

    finishBalancingIfSettled();

    // Must run before anything reads the rate: updateBalancingDisplay()
    // and the Docklight report both ask for the ETA later this tick.
    sampleObservedBalanceRate();

    updateDeviceFreshness();

    renderCells();

    checkWarnings();

    // Only append to the CSV log while the BMS session is started
    updateStats(running);

    updateBalancingDisplay();

    sendBalanceReport();

    // Keep the last readings in sessionStorage so a page refresh redraws the
    // cells with the values that were on screen, instead of dropping them all
    // to 0 V until the board's next frame arrives.
    saveCellSnapshot();

}

// Persist the current cell readings for this tab session, so a refresh can
// restore them. sessionStorage (not localStorage): the snapshot belongs to
// this signed-in session and should not linger after the tab is closed.
function saveCellSnapshot() {

    try {

        sessionStorage.setItem("bmsCellSnapshot", JSON.stringify({
            count: CELL_COUNT,
            sim: simulationEnabled,
            volts: cellVoltages
        }));

    }

    catch (e) { /* storage full or blocked — the live feed still works */ }

}

// Redraw the cells from the last saved snapshot after a refresh. Only real
// measured data is restored: simulated values regenerate on their own, and a
// mismatched count means the pack was resized since the snapshot was taken.
function restoreCellSnapshot() {

    try {

        const raw = sessionStorage.getItem("bmsCellSnapshot");

        if (!raw) return;

        const snap = JSON.parse(raw);

        if (!snap || snap.sim || snap.count !== CELL_COUNT) return;

        if (!Array.isArray(snap.volts) || snap.volts.length !== CELL_COUNT) return;

        cellVoltages = snap.volts.map(Number);

        // Keep it flagged as real data so the simulation drift walk doesn't
        // overwrite the restored readings before the board's next frame.
        simulationEnabled = false;

    }

    catch (e) { /* corrupt snapshot — fall back to the zeros already set */ }

}

// ======================================
// ACTIVE BALANCING
// Mirrors how the board works: charge is
// moved out of the two highest cells and
// into the lowest one, at a rate set by the
// Equalizing Current, tick by tick, until
// no cell sits above the Starting Voltage.
// The high cells discharge; the low cell
// charges. Nothing is burned off.
// ======================================

// The cell receiving charge — the lowest in the pack — but only while
// there is actually a cell discharging into it. Returns -1 otherwise,
// so "nothing is charging" is never confused with "cell 0 is charging".
function chargingCellIndex(discharging = balancingCellIndices()) {

    if (!discharging.length) return -1;

    // Docklight named the pair — use its receiving cell (-1 when it gave
    // only a discharging cell, i.e. dissipate rather than transfer).
    if (manualBalancePair) return manualBalancePair.receiver;

    const lowestIndex = cellVoltages.indexOf(Math.min(...cellVoltages));

    // A cell cannot both give and receive on the same tick. If the pack
    // has collapsed to where the lowest cell is itself discharging,
    // there is no distinct receiver.
    if (discharging.includes(lowestIndex)) return -1;

    // A receiver already at the start voltage is full: applyActiveBalancing()
    // caps it there, so it takes nothing further. Still calling it "charging"
    // would label a cell whose voltage never moves again.
    const startVoltage = parseFloat(document.getElementById("startVoltage").value);

    if (!isNaN(startVoltage) && cellVoltages[lowestIndex] >= startVoltage) return -1;

    return lowestIndex;

}

// Volts moved out of ONE discharging cell per tick. Higher Equalizing
// Current drains faster. Tuned so the effect is visible over a few
// ticks, not instant.
function bleedPerTick() {

    const current = parseFloat(document.getElementById("currentLimit").value);

    if (isNaN(current) || current <= 0) return 0;

    return current * 0.002;

}

// Watches the discharging cell fall and records how fast, so a real
// board's ETA is measured rather than assumed. Called once per tick.
//
// Only counts a drop while the SAME cell keeps discharging: when the
// pair rotates, the new cell's voltage is unrelated to the old one's
// and the difference between them is not a rate.
// Says whether the board is still talking. A frozen dashboard has three
// very different causes, and only this tells them apart:
//   - no frames ever      -> the board is not sending cell data at all
//   - frames went stale   -> it sent some, then stopped
//   - frames still fresh  -> it IS sending, the numbers just aren't moving,
//                            which means the balancer isn't doing anything
function updateDeviceFreshness() {

    const el = document.getElementById("deviceFreshness");

    if (!el) return;

    if (!realDeviceConnected) {

        el.textContent = "";

        el.className = "device-freshness";

        return;

    }

    if (lastCellFrameAt === null) {

        // Expected when the port leads to Docklight rather than a board:
        // the dashboard transmits, nothing sends cell data back.
        el.textContent = "· no cell frames received";

        el.className = "device-freshness stale";

        return;

    }

    const secondsAgo = (Date.now() - lastCellFrameAt) / 1000;

    // Frames should arrive far faster than the 1.5s tick. Three ticks of
    // silence is not jitter, it is a board that stopped talking.
    const stale = secondsAgo > (3 * TICK_MS) / 1000;

    el.textContent = `· last frame ${secondsAgo < 1 ? "just now" : Math.round(secondsAgo) + "s ago"}`;

    el.className = "device-freshness" + (stale ? " stale" : " fresh");

}

function sampleObservedBalanceRate() {

    const sender = balancingCellIndices()[0];

    // Nothing to measure while the dashboard is the one moving the cells.
    if (simulationEnabled || sender === undefined) {

        lastBalanceSample = null;

        observedDropVoltsPerSecond = 0;

        return;

    }

    const now = Date.now();

    const volts = cellVoltages[sender];

    if (lastBalanceSample && lastBalanceSample.index === sender) {

        const elapsed = (now - lastBalanceSample.time) / 1000;

        const dropped = lastBalanceSample.volts - volts;

        // A cell that rose, or held still, tells us nothing about the
        // bleed rate — the board may simply not be balancing.
        if (elapsed > 0 && dropped > 0) {

            const rate = dropped / elapsed;

            // Smooth it: a single noisy ADC reading should nudge the
            // estimate, not redefine it.
            observedDropVoltsPerSecond = observedDropVoltsPerSecond > 0
                ? (observedDropVoltsPerSecond * 0.7) + (rate * 0.3)
                : rate;

        }

    }

    lastBalanceSample = { index: sender, volts, time: now };

}

// How fast the discharging cell is falling, in volts per second.
//
// A real board's measured rate always wins — it is the truth. Only when
// nothing has been measured yet (or on simulated data, where there is
// no board to measure) do we fall back to the configured Equalizing
// Current. Returns 0 when no estimate is possible at all.
function dropVoltsPerSecond() {

    if (!simulationEnabled && observedDropVoltsPerSecond > 0) {

        return observedDropVoltsPerSecond;

    }

    const perTick = bleedPerTick();

    if (perTick <= 0) return 0;

    return perTick / (TICK_MS / 1000);

}

// True when the countdown came from watching real hardware rather than
// from the configured current. The UI says which, so a measured figure
// is never confused with an assumed one.
function balanceRateIsMeasured() {

    return !simulationEnabled && observedDropVoltsPerSecond > 0;

}

// Seconds until no cell sits above the Starting Voltage. Returns null
// when it cannot be estimated honestly — no rate, or nothing to balance.
//
// Exactly one cell discharges at a time, because balancing runs between
// two cells. So the pack sheds its whole excess at that single rate,
// however many cells are over the threshold — they simply take turns.
function estimateBalanceSeconds() {

    const startVoltage = parseFloat(document.getElementById("startVoltage").value);

    const rate = dropVoltsPerSecond();

    if (isNaN(startVoltage) || rate <= 0) return null;

    const excess = cellVoltages
        .filter(v => v > startVoltage)
        .map(v => v - startVoltage);

    if (!excess.length) return null;

    const total = excess.reduce((sum, v) => sum + v, 0);

    // Pure balancing time — if the balancer ran continuously.
    const pureSeconds = total / rate;

    // Real balancer runs on a duty cycle set in Equalization Settings:
    // balance for ON seconds, rest for OFF seconds, repeating. So wall-clock
    // time is longer — add one OFF gap after each full ON block but the last.
    const onS = balanceOnSeconds();
    const offS = balanceOffSeconds();

    const gaps = Math.max(0, Math.ceil(pureSeconds / onS) - 1);

    return pureSeconds + gaps * offS;

}

// Duty-cycle values from Equalization Settings, falling back to the
// defaults if the fields are empty or invalid.
function balanceOnSeconds() {

    const v = parseFloat(document.getElementById("balanceOnTime")?.value);
    return !isNaN(v) && v > 0 ? v : BALANCE_ON_S;

}

function balanceOffSeconds() {

    const v = parseFloat(document.getElementById("balanceOffTime")?.value);
    return !isNaN(v) && v >= 0 ? v : BALANCE_OFF_S;

}

// Takes a fresh projection of when the balance will finish. Called at
// BALANCING START and whenever the Equalizing Current or Starting
// Voltage changes — never per tick.
function resetBalanceEstimate() {

    const seconds = estimateBalanceSeconds();

    balanceDeadlineAt = seconds === null ? null : Date.now() + (seconds * 1000);

}

// Seconds left on the frozen projection. Never negative: a balance that
// overruns its estimate reads "1s", not a growing negative number.
function balanceSecondsRemaining() {

    if (balanceDeadlineAt === null) return null;

    return Math.max(0, (balanceDeadlineAt - Date.now()) / 1000);

}

// The wall-clock time the balance is projected to finish — e.g. "3:00 PM"
// — rather than a countdown. So at 2:30 with 30 min to go it reads 3:00.
// Returns null when there is no estimate.
function balanceCompletionClock() {

    if (balanceDeadlineAt === null) return null;

    return new Date(balanceDeadlineAt).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit"
    });

}

// Stops the balancer once no cell sits above the Starting Voltage, so a
// finished balance reports itself instead of leaving the box up forever.
//
// Simulated data only. On a real board the readings carry ADC noise, and
// one sample dipping under the threshold does not mean the balance is
// done — that call belongs to the firmware, which is the thing actually
// moving charge. The dashboard would only be guessing, and a wrong guess
// sends "$BALSTOP#" and halts a balance that was still working.
function finishBalancingIfSettled() {

    if (!balancingActive || !simulationEnabled) return;

    if (balancingCellIndices().length) return;

    balancingCompletedCount++;

    logEvent("✅ Balancing Complete — All Cells At Starting Voltage", "success");

    // The whole-pack cycle limit was removed. Balancing is now bounded
    // only by the per-cell "balanced too many times" guard, not by a
    // count of full-pack cycles — so completing a cycle never locks out.
    saveBalanceStats();

    stopBalancing();

}

// Plain informational count of today's balancing — no limit, since the
// whole-pack cycle limit was removed. Shows completed cycles, with how
// many were started underneath.
function updateBalancingCycleStat() {

    const value = document.getElementById("balancingCycles");
    const sub = document.getElementById("balancingCyclesSub");

    if (value) {

        value.innerHTML = `${balancingCompletedCount}`;

        value.className = "stat-value cyan-color";

    }

    if (!sub) return;

    sub.innerHTML = balancingCycleCount === 0
        ? "today"
        : `${balancingCycleCount} started today`;

}

function applyActiveBalancing() {

    // Once real cell data has arrived the board owns those values
    // completely. Moving charge here would silently fight whatever gets
    // sent next, making new real readings look like they're "not taking
    // effect." Only simulated data gets the simulated transfer.
    if (!simulationEnabled) return;

    // Balancing switched off at the buttons — no charge moves.
    if (!balancingActive) return;

    const startVoltage = parseFloat(document.getElementById("startVoltage").value);

    const perTick = bleedPerTick();

    // No Equalizing Current configured — matches real hardware with the
    // balancer switched off — so no charge moves.
    if (isNaN(startVoltage) || perTick <= 0) return;

    const discharging = balancingCellIndices();

    if (!discharging.length) return;

    const receiver = chargingCellIndex(discharging);

    // Exactly one cell discharges into exactly one other — never more
    // than two cells at a time. The sender floors at the start voltage,
    // drops out, and the next-highest cell takes over on the next tick.
    const sender = discharging[0];

    const before = cellVoltages[sender];

    cellVoltages[sender] = Math.max(startVoltage, before - perTick);

    const moved = before - cellVoltages[sender];

    if (receiver === -1 || moved <= 0) return;

    // The receiver takes what it can hold up to the start voltage; charge
    // beyond that is dissipated, exactly as a bleed resistor would.
    //
    // This is NOT lossless, and it cannot be. Lossless transfer conserves
    // the pack total, so it converges on the pack MEAN — and whenever the
    // mean sits above the start voltage, no amount of shuffling can get
    // every cell below it. Real boards resolve this the same way: move
    // what the low cell can absorb, burn off the remainder. Capping the
    // receiver here is what makes the pack actually settle.
    cellVoltages[receiver] = Math.min(startVoltage, cellVoltages[receiver] + moved);

}

// ======================================
// RENDER CELL VALUES
// ======================================

function renderCells() {

    for (let i = 1; i <= CELL_COUNT; i++) {

        const voltage = cellVoltages[i - 1];

        document.getElementById(`cellVal${i}`).innerHTML =
            voltage.toFixed(3) + " V";

        // How many times this cell has been on each end of a transfer.
        const counts = document.getElementById(`cellCount${i}`);

        if (counts) {

            counts.innerHTML =
                `<span class="count-discharge">▼ ${cellDischargeCount[i - 1]}</span>` +
                `<span class="count-charge">▲ ${cellChargeCount[i - 1]}</span>`;

        }

        // Drives the circular gauge fill — purely visual, mapped across
        // the 3.0V-4.0V simulated range (no numeric % shown to the user).
        const pct = Math.min(100, Math.max(0, ((voltage - 3.0) / 1.0) * 100));

        const gauge = document.getElementById(`cellGauge${i}`);

        if (gauge) gauge.style.setProperty("--pct", pct.toFixed(1));

    }

}

// ======================================
// HIGHLIGHT HIGH / LOW CELLS
// ======================================

function highlightExtremes(maxCell, minCell) {

    for (let i = 1; i <= CELL_COUNT; i++) {

        const card = document.getElementById(`cellCard${i}`);
        const badge = document.getElementById(`cellBadge${i}`);

        card.classList.remove("cell-high", "cell-low");
        badge.innerHTML = "";

        if (i === maxCell) {

            card.classList.add("cell-high");
            badge.innerHTML = `🔋 HIGH`;

        }

        if (i === minCell) {

            card.classList.add("cell-low");
            badge.innerHTML = `🪫 LOW`;

        }

    }

}

// ======================================
// UPDATE TIMER
// ======================================

function updateTimer() {

    seconds++;

    let hrs = Math.floor(seconds / 3600);

    let mins = Math.floor((seconds % 3600) / 60);

    let secs = seconds % 60;

    hrs = String(hrs).padStart(2, "0");
    mins = String(mins).padStart(2, "0");
    secs = String(secs).padStart(2, "0");

    document.getElementById("timer").innerHTML =
        `${hrs}:${mins}:${secs}`;

}

// ======================================
// UPDATE STATISTICS
// ======================================

function updateStats(shouldLog = false) {

    const totalVoltage =
        cellVoltages.reduce((a, b) => a + b, 0);

    const maxVoltage = Math.max(...cellVoltages);

    const minVoltage = Math.min(...cellVoltages);

    const maxCell = cellVoltages.indexOf(maxVoltage) + 1;

    const minCell = cellVoltages.indexOf(minVoltage) + 1;

    const averageVoltage = totalVoltage / cellVoltages.length;

    const difference = maxVoltage - minVoltage;

    // Balancer power = the discharging cell's voltage × the Equalizing
    // Current set in Equalization Settings. Zero when nothing is discharging.
    const eqCurrent =
        parseFloat(document.getElementById("currentLimit")?.value) || 0;

    const balIdx = balancingCellIndices();

    const dischargerVoltage = balIdx.length ? cellVoltages[balIdx[0]] : 0;

    const balancerPower = dischargerVoltage * eqCurrent;

    const capacityUsed =
        cellVoltages.reduce((sum, v) => sum + Math.round(v * 10), 0) /
        cellVoltages.length;

    highlightExtremes(maxCell, minCell);

    if (shouldLog) {

        logRow([
            asCsvText(todayDateStr()),
            asCsvText(csvTimeStr()),
            ...cellVoltages.map(v => v.toFixed(3)),
            totalVoltage.toFixed(3), eqCurrent.toFixed(2), balancerPower.toFixed(2),
            maxCell, maxVoltage.toFixed(3), minCell, minVoltage.toFixed(3),
            averageVoltage.toFixed(3), difference.toFixed(3), capacityUsed.toFixed(1)
        ]);

    }

    const balancerPowerEl = document.getElementById("balancerPower");

    if (balancerPowerEl)
        balancerPowerEl.innerHTML = balancerPower.toFixed(2) + " W";

    document.getElementById("maxVoltage").innerHTML =
        maxVoltage.toFixed(3) + " V";

    document.getElementById("maxCellLabel").innerHTML =
        "Cell " + maxCell;

    document.getElementById("minVoltage").innerHTML =
        minVoltage.toFixed(3) + " V";

    document.getElementById("minCellLabel").innerHTML =
        "Cell " + minCell;

    document.getElementById("avgVoltage").innerHTML =
        averageVoltage.toFixed(3) + " V";

    document.getElementById("diffVoltage").innerHTML =
        difference.toFixed(3) + " V";

    // Max/Total capacity tiles were removed from the dashboard. capacityUsed
    // is still computed above because the CSV log keeps its column; it just
    // has no on-screen tile to update anymore.

    // While balancing, the Voltage Difference tile pulses light blue to
    // draw the eye to the number that is actively shrinking.
    const diffItem = document.getElementById("diffVoltage").closest(".stat-item");

    if (diffItem) diffItem.classList.toggle("balancing-blink", balancingActive);

}

// ======================================
// CURRENT ZERO
// ======================================

function currentZero(transmit = true) {

    if (!running) {

        alert("Please start the BMS first.");

        return;

    }

    updateStats();

    showStatus("⚡ Current Reset Successfully", "success");

    if (transmit) sendSerialCommand("CURRENTZERO");

}

// ======================================
// EQUALIZATION SETTINGS (in-page modal —
// opening/closing it never touches the
// running BMS session, timer, or log file)
// ======================================

function equalizationSetting() {

    document.getElementById("eqOverlay").classList.add("open");

}

function closeEqualization() {

    document.getElementById("eqOverlay").classList.remove("open");

}

// Briefly flashes an input's border green (saved) or red (invalid)
// instead of an interruptive alert popup.
function flashField(input, ok) {

    input.style.transition = "border-color .2s, box-shadow .2s";
    input.style.borderColor = ok ? "#16a34a" : "#dc2626";
    input.style.boxShadow = ok
        ? "0 0 0 3px rgba(22,163,74,.15)"
        : "0 0 0 3px rgba(220,38,38,.15)";

    setTimeout(() => {

        input.style.borderColor = "";
        input.style.boxShadow = "";

    }, 900);

}

function save(parameter, valueId, lowId) {

    const valueInput = document.getElementById(valueId);

    // Equilibrium Limit Voltage still has separate High/Low fields
    if (lowId) {

        const lowInput = document.getElementById(lowId);

        const high = parseFloat(valueInput.value);
        const low = parseFloat(lowInput.value);

        if (isNaN(high) || isNaN(low) || high <= low) {

            flashField(valueInput, false);
            flashField(lowInput, false);

            return;

        }

        flashField(valueInput, true);
        flashField(lowInput, true);

        // HIGH and LOW share one SET button, but only transmit
        // whichever one(s) actually changed — otherwise touching just
        // LOW still re-sends HIGH's unchanged value every time.
        const previousHigh = parseFloat(localStorage.getItem(`eqSetting_${valueId}`));
        const previousLow = parseFloat(localStorage.getItem(`eqSetting_${lowId}`));

        saveEqSetting(valueId);
        saveEqSetting(lowId);

        if (FIELD_KEY_BY_ID[valueId] && high !== previousHigh) sendSerialCommand(`SET ${FIELD_KEY_BY_ID[valueId]}:${high}`);
        if (FIELD_KEY_BY_ID[lowId] && low !== previousLow) sendSerialCommand(`SET ${FIELD_KEY_BY_ID[lowId]}:${low}`);

        return;

    }

    // Every other parameter is a single value
    const value = parseFloat(valueInput.value);

    if (isNaN(value)) {

        flashField(valueInput, false);

        return;

    }

    // Over-voltage fault state only clears once voltage drops below the
    // Recovery limit — so if the Protection or Recovery limit itself is
    // changed, re-arm every cell against the new limit immediately
    // instead of leaving stale trips until they happen to recover
    // (or the page is refreshed).
    if (parameter === "Monomer Over Voltage Protection" || parameter === "Monomer Over Voltage Recovery") {

        cellOVFault = new Array(CELL_COUNT).fill(false);

    }

    flashField(valueInput, true);

    saveEqSetting(valueId);

    if (FIELD_KEY_BY_ID[valueId]) sendSerialCommand(`SET ${FIELD_KEY_BY_ID[valueId]}:${value}`);

}

// ======================================
// STRING NUMBER — changes how many cells
// are shown on the dashboard
// ======================================

// Rebuilds all per-cell arrays and the dashboard grid for a new cell
// count — shared by the String Number setting and by real hardware
// reporting a different number of cells than currently configured.
function resizeCellCount(newCount) {

    CELL_COUNT = newCount;

    cellVoltages = new Array(CELL_COUNT).fill(0);
    cellOVFault = new Array(CELL_COUNT).fill(false);
    cellUVFault = new Array(CELL_COUNT).fill(false);
    cellBalancing = new Array(CELL_COUNT).fill(false);
    cellCharging = new Array(CELL_COUNT).fill(false);
    cellDischargeCount = new Array(CELL_COUNT).fill(0);
    cellChargeCount = new Array(CELL_COUNT).fill(0);
    cellDischargedThisCycle = new Array(CELL_COUNT).fill(false);
    cellChargedThisCycle = new Array(CELL_COUNT).fill(false);

    createCells();

}

function applyStringNumber(transmit = true) {

    const input = document.getElementById("stringCount");
    const value = parseInt(input.value, 10);

    // No upper limit — any cell count is accepted. Only a count below 1 is
    // rejected, because a pack of 0 cells has no statistics to compute.
    if (isNaN(value) || value < 1) {

        flashField(input, false);

        return;

    }

    resizeCellCount(value);

    initCellVoltages();
    renderCells();
    updateStats(false);

    flashField(input, true);

    saveEqSetting("stringCount");

    if (transmit) sendSerialCommand(`SET CELLS:${value}`);

}

// ======================================
// LIVE WARNING MONITORING
// Checks every cell against every
// configured limit in Equalization
// Settings and shows warnings accordingly
// ======================================

// Which banner warnings are currently standing, keyed by their stable
// key. Kept so a condition that clears can be logged with the same
// wording it appeared under.
let activeAlerts = new Map();

// Writes a banner warning into the Activity Log the moment it appears,
// and again the moment it clears. Not every tick it persists — at 1.5s
// per tick a single standing warning would bury the log in minutes.
//
// The "balancing active" alert is skipped: it is not a warning, and the
// per-cell "Cell N Balancing Started" lines already record that history.
function logAlertChanges(alerts) {

    const current = new Map();

    alerts
        .filter(alert => alert.level !== "info")
        .forEach(alert => current.set(alert.key, alert));

    current.forEach((alert, key) => {

        if (!activeAlerts.has(key)) logEvent(alert.text, "error");

    });

    activeAlerts.forEach((alert, key) => {

        if (current.has(key)) return;

        // Some conditions do not "resolve" — the cycle warning is replaced
        // by the cycle limit, which is worse, not better. Logging a green
        // "Cleared" line for those would read as good news.
        if (alert.noClearLog) return;

        // Strip the leading warning glyph: the condition is over, so the
        // line should not still read as an alarm.
        logEvent(`✅ Cleared — ${alert.text.replace(/^[^\w]+\s*/, "")}`, "success");

    });

    activeAlerts = current;

}

function formatCellList(indices) {

    const numbers = indices.map(i => i + 1);

    if (numbers.length <= 5) return numbers.join(", ");

    return numbers.slice(0, 5).join(", ") + ` +${numbers.length - 5} more`;

}

function checkWarnings() {

    const banner = document.getElementById("safetyBanner");

    const eqHigh = parseFloat(document.getElementById("eqHigh").value);
    const eqLow = parseFloat(document.getElementById("eqLow").value);
    const diffLimit = parseFloat(document.getElementById("diffLimit").value);
    const ovLimit = parseFloat(document.getElementById("ovProtection").value);
    const ovRecovery = parseFloat(document.getElementById("ovRecovery").value);
    const uvLimit = parseFloat(document.getElementById("uvProtection").value);

    const aboveLimit = [];
    const belowLimit = [];
    const overVoltage = [];
    const underVoltage = [];
    const balancing = [];

    // Computed once for the whole pack, not per cell — whether a cell is
    // balancing depends on how it ranks against the others, which a
    // per-cell voltage test cannot answer.
    const dischargingCells = balancingCellIndices();

    const balancingSet = new Set(dischargingCells);

    const receiver = chargingCellIndex(dischargingCells);

    // Set by the per-cell loop when a discharge/charge tally ticks up, so
    // the day's totals are persisted once after the loop rather than on
    // every cell.
    let countsChanged = false;

    for (let i = 0; i < CELL_COUNT; i++) {

        const v = cellVoltages[i];
        const card = document.getElementById(`cellCard${i + 1}`);

        const wasOV = cellOVFault[i];
        const wasUV = cellUVFault[i];
        const wasBalancing = cellBalancing[i];

        // Declared up here, not beside its first use below: the
        // participation counters read it before the card rendering does.
        const isCharging = i === receiver;

        // Equilibrium Limit Voltage — absolute safe window
        if (!isNaN(eqHigh) && v > eqHigh) aboveLimit.push(i);
        if (!isNaN(eqLow) && v < eqLow) belowLimit.push(i);

        // Monomer Over Voltage Protection / Recovery
        if (!isNaN(ovLimit) && !cellOVFault[i] && v > ovLimit) {

            cellOVFault[i] = true;

        }

        if (cellOVFault[i] && !isNaN(ovRecovery) && v < ovRecovery) {

            cellOVFault[i] = false;

        }

        if (cellOVFault[i]) overVoltage.push(i);

        // Single Under Voltage Protection
        if (!isNaN(uvLimit) && v < uvLimit) {

            cellUVFault[i] = true;
            underVoltage.push(i);

        } else {

            cellUVFault[i] = false;

        }

        // Equalizing Starting Voltage — which cells are actively balancing.
        // Only while the balancer is switched on: with it off, a cell over
        // the start voltage is not being bled, so flagging it as balancing
        // would contradict the buttons and the box below them.
        const isBalancing = balancingSet.has(i);

        cellBalancing[i] = isBalancing;

        if (isBalancing) balancing.push(i);

        // Log only the moment something actually changes, not every
        // tick it stays that way — this is what builds real history.
        if (!wasOV && cellOVFault[i]) logEvent(`🚨 Cell ${i + 1} Over-Voltage`, "error");
        if (wasOV && !cellOVFault[i]) logEvent(`✅ Cell ${i + 1} Over-Voltage Recovered`, "success");

        if (!wasUV && cellUVFault[i]) logEvent(`🚨 Cell ${i + 1} Under-Voltage`, "error");
        if (wasUV && !cellUVFault[i]) logEvent(`✅ Cell ${i + 1} Under-Voltage Recovered`, "success");

        if (!wasBalancing && isBalancing) logEvent(`⚖ Cell ${i + 1} Balancing Started`, "info");
        if (wasBalancing && !isBalancing) logEvent(`✅ Cell ${i + 1} Balancing Successful`, "success");

        // First participation in this cycle, not every turn it takes.
        if (isBalancing && !cellDischargedThisCycle[i]) {

            cellDischargedThisCycle[i] = true;

            cellDischargeCount[i]++;

            countsChanged = true;

        }

        if (isCharging && !cellChargedThisCycle[i]) {

            cellChargedThisCycle[i] = true;

            cellChargeCount[i]++;

            countsChanged = true;

        }

        cellCharging[i] = isCharging;

        if (card) {

            card.classList.toggle("uv-fault", cellUVFault[i]);
            card.classList.toggle("ov-fault", cellOVFault[i]);
            card.classList.toggle("balancing", isBalancing);
            card.classList.toggle("charging", isCharging);

        }

        // Small text labels underneath the gauge name the specific
        // condition; the glowing border (toggled above) gives the
        // at-a-glance signal. All that apply are shown together, not
        // just the most severe one.
        const msgContainer = document.getElementById(`cellMsg${i + 1}`);

        if (msgContainer) {

            // Each badge carries its own modifier class so the colour
            // says which condition it is before the words are read.
            const texts = [];

            if (cellOVFault[i]) texts.push({ text: "⚠ Over-Voltage", cls: "fault" });
            if (cellUVFault[i]) texts.push({ text: "⚠ Under-Voltage", cls: "fault" });

            // ⚖ marks a cell the balancer is acting on; the arrow says
            // which way charge is flowing. Both cells of the pair carry
            // the scales — a charging cell is not itself "balancing" in
            // the cellBalancing[] sense, but it is being balanced.
            if (isBalancing) texts.push({ text: "⚖ ▼ DISCHARGING", cls: "discharging" });
            if (isCharging) texts.push({ text: "⚖ ▲ CHARGING", cls: "charging" });

            // Over-balancing warning from the board — an amber badge naming
            // the direction and run count. Expires if no fresh warning for
            // this cell arrives within the window.
            const ob = cellOverBalance[i];

            if (ob) {

                if (Date.now() - ob.at < OVERBAL_EXPIRE_MS) {

                    texts.push({
                        text: `⚠ Over-bal ${ob.dir === "FORWARD" ? "▶" : "◀"} ${ob.runs}`,
                        cls: "overbal"
                    });

                }

                else delete cellOverBalance[i];

            }

            // Dashboard-side over-balance warning: when this cell's own
            // discharge or charge count reaches the limit set in EQ
            // Settings, flag it (▶ discharge / ◀ charge) and log it once.
            const warnLimit = overBalWarnLimit();
            const overDischarge = cellDischargeCount[i] >= warnLimit;
            const overCharge = cellChargeCount[i] >= warnLimit;

            if (overDischarge || overCharge) {

                const dir = overDischarge ? "▶" : "◀";
                const count = overDischarge ? cellDischargeCount[i] : cellChargeCount[i];

                texts.push({ text: `⚠ Over-bal ${dir} ${count}`, cls: "overbal" });

                // Repeat the warning every 5 s while the cell stays over the
                // limit — fires immediately on first crossing (last = 0).
                if (Date.now() - cellOverBalLastWarn[i] >= OVERBAL_WARN_REPEAT_MS) {

                    cellOverBalLastWarn[i] = Date.now();

                    // Exact board message format (8 = FORWARD/discharge,
                    // 9 = REVERSE/charge), Cell zero-padded to two digits.
                    const cellStr = String(i + 1).padStart(2, "0");
                    const path = overDischarge ? "FORWARD" : "REVERSE";

                    logEvent(`WARNING: Cell${cellStr} is over-balancing in ${path} path! (${count} runs)`, "error");
                    showStatus(`⚠ Cell ${i + 1} over-balancing (${path})`, "stop");

                }

            }

            else cellOverBalLastWarn[i] = 0;

            msgContainer.innerHTML = texts
                .map(t => `<span class="cell-msg ${t.cls}">${t.text}</span>`)
                .join("");

            msgContainer.style.display = texts.length ? "flex" : "none";

        }

    }

    // Per-cell transfer limit. Enforced here, right after the counts were
    // updated above, so a cell crossing the line is caught on the same
    // tick — not one tick late. Works for real and simulated data alike,
    // since both drive the same cellDischargeCount / cellChargeCount.
    const worstCellCount = maxCellTransferCount();

    if (balancingActive && worstCellCount > CELL_TRANSFER_LIMIT) {

        // Lock BEFORE stopBalancing(), which re-enables the START button
        // off this same flag — it must not re-enable what the limit just
        // disabled. Reuses the day's lockout: the effect is identical
        // (no more balancing today), and it persists and clears the same.
        balancingLockedOut = true;

        saveBalanceStats();

        showStatus(`⛔ Balancing Stopped — A Cell Was Balanced Too Many Times`, "stop");

        stopBalancing();

    }

    // Build a short, plain-language alert per condition — never one
    // combined line per cell, so the list stays easy to read.
    // Each alert carries a stable key. The banner is rebuilt from scratch
    // every tick, but the Activity Log must record a condition once when
    // it appears and once when it clears — never 40 times a minute for as
    // long as it persists. The key is what stays the same while the text
    // changes (the cell list, the spread), so it is what we compare on.
    const alerts = [];

    // AFE (cell-reading chip) comm failure — stays on the banner while the
    // fault is active; the "AFE Communication OK" message clears afeFailed.
    if (afeFailed) {

        alerts.push({
            key: "afeFail",
            level: "critical",
            text: "🚨 AFE Communication Fail — cell readings may be unreliable"
        });

    }

    // Balancer MCP expander fault — stays on the banner while active;
    // "BALANCER : NORMAL" clears it.
    if (balancerFaulted()) {

        const f = [];
        if (mcp1Failed) f.push("MCP1");
        if (mcp2Failed) f.push("MCP2");

        alerts.push({
            key: "balancerFault",
            level: "critical",
            text: `🚨 Balancer Hardware Fault (${f.join(" & ")}) — balancing may not work`
        });

    }

    // Which cells are in the warning band (7..10) or over the limit, so
    // the banner can name them. Shown for both real and automatic data.
    const cellsNearLimit = [];
    const cellsOverLimit = [];

    for (let i = 0; i < CELL_COUNT; i++) {

        const worst = Math.max(cellDischargeCount[i], cellChargeCount[i]);

        if (worst > CELL_TRANSFER_LIMIT) cellsOverLimit.push(i);

        else if (worst >= CELL_TRANSFER_WARN_AT) cellsNearLimit.push(i);

    }

    if (cellsOverLimit.length) {

        alerts.push({
            key: "cellTransferLimit",
            level: "critical",
            text: `⛔ Balancing Stopped — Cell ${formatCellList(cellsOverLimit)} Balanced Too Many Times`
        });

    }

    if (cellsNearLimit.length) {

        // Red, not amber: the operator asked for this one to stand out at
        // the top of the dashboard as an urgent, approaching-limit alert.
        alerts.push({
            key: "cellTransferWarn",
            level: "critical",
            text: `⚠ Cell ${formatCellList(cellsNearLimit)} Balancing Too Often`
        });

    }

    if (overVoltage.length) {

        alerts.push({
            key: "overVoltage",
            level: "warning",
            text: `⚠ Over-Voltage — Cell ${formatCellList(overVoltage)}`
        });

    }

    if (underVoltage.length) {

        alerts.push({
            key: "underVoltage",
            level: "critical",
            text: `🚨 Under-Voltage — Cell ${formatCellList(underVoltage)}`
        });

    }

    if (aboveLimit.length) {

        alerts.push({
            key: "aboveLimit",
            level: "warning",
            text: `⚠ Above Safe Limit — Cell ${formatCellList(aboveLimit)}`
        });

    }

    if (belowLimit.length) {

        alerts.push({
            key: "belowLimit",
            level: "warning",
            text: `⚠ Below Safe Limit — Cell ${formatCellList(belowLimit)}`
        });

    }

    // Equalizing Starting Voltage — balancing indicator. Names BOTH cells
    // of the pair: "Cell 15" alone never said where the charge was going.
    if (balancing.length) {

        const sender = balancing[0];

        alerts.push({
            key: "balancingActive",
            level: "info",
            text: receiver === -1
                ? `⚖ Balancing Active — Cell ${sender + 1} ▼ discharging`
                : `⚖ Balancing Active — Cell ${sender + 1} ▼ → Cell ${receiver + 1} ▲`
        });

    }

    // The whole-pack cycle budget no longer shows a banner — the per-cell
    // transfer warning above is the one the operator watches. The cycle
    // count and its lockout still work; they are just not surfaced here.

    // Equalizing Differential Voltage
    const spread = Math.max(...cellVoltages) - Math.min(...cellVoltages);

    if (!isNaN(diffLimit) && spread > diffLimit) {

        alerts.push({
            key: "imbalance",
            level: "warning",
            text: `⚠ Cell Imbalance — ${spread.toFixed(3)}V spread`
        });

    }

    if (countsChanged) saveBalanceStats();

    logAlertChanges(alerts);

    if (alerts.length) {

        banner.innerHTML = alerts
            .map(a => `<div class="warning-item level-${a.level}">${a.text}</div>`)
            .join("");

        banner.style.display = "flex";

    } else {

        banner.style.display = "none";

    }

}

async function restartSystem() {

    // Restart signals the device — it sends the "$RESTART#" frame and the
    // ">> SYSTEM RESTART" line Docklight shows the operator. The dashboard
    // itself is NOT reloaded and the session is not torn down.
    await sendSerialCommand("RESTART");

    // The board restarts, so every reading on screen is from before the
    // restart and no longer describes anything. Blank the cells to 0.000 V
    // rather than leave stale voltages sitting there looking live — the
    // next frames from the device fill them back in.
    zeroOutCellVoltages();

    renderCells();

    updateStats();

    showStatus("↻ System Restart Sent — Cells Reset To 0", "success");

    logEvent("↻ System Restart — sent to device, cells reset to 0", "info");

}

// ======================================
// AUTOMATIC EQUALIZATION
// ======================================

function autoEqualization(transmit = true) {

    if (!running) {

        alert("Please start the BMS first.");

        return;

    }

    const highest = Math.max(...cellVoltages);

    const lowest = Math.min(...cellVoltages);

    const difference = highest - lowest;

    if (transmit) sendSerialCommand("AUTOEQUALIZE");

    if (difference <= BALANCED_DIFF_V) {

        showStatus("✅ Battery Already Balanced", "success");

    }

    else {

        showStatus("⚡ Automatic Equalization Started", "success");

        setTimeout(() => {

            alert(
                "Equalization Complete\n\n" +
                "Highest Cell : " + highest.toFixed(3) + " V\n" +
                "Lowest Cell : " + lowest.toFixed(3) + " V\n" +
                "Difference : " + difference.toFixed(3) + " V"
            );

        }, 2000);

    }

}

// ======================================
// BALANCING START / STOP
// The two highest cells are the ones the
// balancer works on, so the box under the
// buttons names that pair and follows it
// live as the voltages move.
// ======================================

// The cells currently tripped on under-voltage, as 1-based numbers.
//
// Returns nothing when the pack has no readings at all (every cell still
// 0.000 V): that is "no data yet", not sixteen under-voltage faults, and
// must not be used to refuse a start before the first frame has arrived.
function underVoltageCells() {

    if (!cellVoltages.length || Math.max(...cellVoltages) <= 0) return [];

    return cellUVFault
        .map((faulted, index) => (faulted ? index + 1 : -1))
        .filter(index => index !== -1);

}

// A pack counts as already balanced once its highest and lowest cell are
// within this much of each other. Deliberately NOT the Equalizing
// Differential Voltage setting: that defaults to 1.5 V — a loose "this pack
// is badly out" warning threshold — and using it here would call almost any
// real pack balanced and refuse to ever start. This is the same 0.020 V
// Automatic Equalization has always called balanced, so both paths agree.
const BALANCED_DIFF_V = 0.02;

// Returns false when there is nothing to judge (no readings yet, so every
// cell reads 0.000 V): a spread of zero there means "no data", not
// "perfectly balanced", and must not be used to refuse a start.
function packAlreadyBalanced() {

    if (cellVoltages.length < 2) return false;

    const highest = Math.max(...cellVoltages);

    if (highest <= 0) return false;

    return highest - Math.min(...cellVoltages) <= BALANCED_DIFF_V;

}

// Sets the balancing pair sent from Docklight and switches balancing on so
// the dashboard shows exactly that pair. Both cells are 0-based indices;
// receiver is -1 for "discharge only, no receiver".
function setManualBalancePair(sender, receiver) {

    if (isNaN(sender) || sender < 0 || sender >= CELL_COUNT) {

        showStatus(`⚠ Invalid Balancing Cell — ${isNaN(sender) ? "?" : sender + 1}`, "stop");
        logEvent(`⚠ Balancing Refused — Cell ${sender + 1} Out Of Range`, "error");

        return;

    }

    // A cell cannot charge itself, and an out-of-range receiver is treated as
    // "no receiver" (dissipate) rather than an error.
    if (isNaN(receiver) || receiver < 0 || receiver >= CELL_COUNT || receiver === sender) {

        receiver = -1;

    }

    // Re-sending the SAME pair (a Docklight loop repeats the command every
    // couple of seconds) must be a no-op — no repaint, no message. Only an
    // actual change is acted on, so nothing spams the screen.
    if (balancingActive && manualBalancePair &&
        manualBalancePair.sender === sender &&
        manualBalancePair.receiver === receiver) {

        return;

    }

    manualBalancePair = { sender, receiver };

    balancingActive = true;

    const box = document.getElementById("balancingBox");
    if (box) box.style.display = "flex";

    // Recompute cellBalancing / cellCharging from the new pair, then repaint
    // the balancing line, the cell badges, and Docklight.
    checkWarnings();
    updateBalancingDisplay();
    renderCells();

}

async function startBalancing(transmit = true) {

    // A dashboard-driven start uses the dashboard's own highest→lowest pick,
    // so clear any pair Docklight had pinned.
    manualBalancePair = null;


    // Independent of the BMS session — BALANCING START starts balancing on
    // its own (sends "$BALSTART#"), and START never triggers it. No "start
    // the BMS first" requirement.
    if (balancingActive) return;

    // Reachable from the button, from startBMS(), and from a remote
    // "$BALSTART#" — so the per-cell lockout is enforced here, at the one
    // door they all pass through, rather than at each caller.
    if (balancingLockedOut) {

        showStatus("⛔ Balancing Disabled — A Cell Was Balanced Too Many Times", "stop");
        logEvent("⛔ Balancing Disabled — A Cell Was Balanced Too Many Times", "error");

        return;

    }

    // Balancing physically moves charge using the Equalizing Current. At 0 A
    // the balancer would cycle on and off without ever draining anything, so
    // there is nothing to start — say so and set a current first.
    const eqCurrent = parseFloat(document.getElementById("currentLimit").value);

    if (isNaN(eqCurrent) || eqCurrent <= 0) {

        showStatus("⛔ Balancing Blocked — Equalizing Current Is 0 (Set A Current First)", "stop");
        logEvent("⛔ Balancing Blocked — Equalizing Current Is 0", "error");

        return;

    }

    // Refuse to balance a pack with an under-voltage cell. Balancing drains
    // the highest cell into the lowest, so running it now would pull charge
    // toward a cell that is already below its safe limit — the fault has to
    // be dealt with first.
    const under = underVoltageCells();

    if (under.length) {

        showStatus(`⛔ Balancing Blocked — Under-Voltage On Cell ${under.join(", ")}`, "stop");
        logEvent(`⛔ Balancing Blocked — Under-Voltage On Cell ${under.join(", ")}`, "error");

        return;

    }

    // Nothing to do — the pack is already within the Equalizing Differential
    // Voltage. Say so instead of opening a balancing session that would just
    // cycle the balancer for no gain.
    if (packAlreadyBalanced()) {

        const spread = Math.max(...cellVoltages) - Math.min(...cellVoltages);

        showStatus(`✅ Cells Already Balanced — Balancing Not Started (Difference ${spread.toFixed(3)} V)`, "success");
        logEvent(`✅ Cells Already Balanced — Balancing Not Started (Difference ${spread.toFixed(3)} V)`, "success");

        return;

    }

    // The balancer's MCP expander is faulted — the hardware can't act, so
    // refuse to start rather than pretend a balance is running.
    if (balancerFaulted()) {

        showStatus("⛔ Balancing Blocked — Balancer Hardware Fault (MCP)", "stop");
        logEvent("⛔ Balancing Blocked — Balancer Hardware Fault (MCP)", "error");

        return;

    }

    balancingActive = true;

    balancingCycleCount++;

    // Each START begins a fresh count: the per-cell charge/discharge
    // counts start from 0 and then build up while this session runs,
    // right through to STOP. (They used to carry over between sessions.)
    cellDischargeCount = new Array(CELL_COUNT).fill(0);
    cellChargeCount = new Array(CELL_COUNT).fill(0);
    cellOverBalLastWarn = new Array(CELL_COUNT).fill(0);
    cellOverBalance = {};

    // A fresh cycle: every cell may be counted once again.
    cellDischargedThisCycle = new Array(CELL_COUNT).fill(false);
    cellChargedThisCycle = new Array(CELL_COUNT).fill(false);

    saveBalanceStats();

    updateBalancingCycleStat();

    // Show the zeroed counts on the cells right away, rather than waiting
    // for the next live tick to repaint them.
    renderCells();

    // The dedicated balancing buttons were removed (balancing is driven by
    // START/STOP), so guard these in case the elements are absent.
    const bStart = document.getElementById("balStartBtn");
    const bStop = document.getElementById("balStopBtn");
    if (bStart) { bStart.disabled = true; bStart.classList.add("running"); }
    if (bStop) bStop.disabled = false;

    document.getElementById("balancingBox").style.display = "flex";
    document.getElementById("etaBox").style.display = "block";

    // cellBalancing[] was computed on the last tick, when balancingActive
    // was still false — so every entry is false right now. Recompute it
    // before reading it, or the box opens claiming nothing is balancing
    // and stays wrong until liveDataTick() next comes around.
    checkWarnings();

    // Project the finish time once, from the pack as it stands now.
    resetBalanceEstimate();

    updateBalancingDisplay();

    showStatus("⚖ Balancing Started", "success");

    logEvent("⚖ Balancing Started", "success");

    if (transmit) await sendSerialCommand("BALSTART");

}

async function stopBalancing(transmit = true) {

    if (!balancingActive) return;

    balancingActive = false;

    // Any Docklight-pinned pair ends with the balance — the next start picks
    // fresh, whether it comes from Docklight or the dashboard.
    manualBalancePair = null;

    balanceDeadlineAt = null;

    // The per-cell charge/discharge counts are left as they stand at STOP
    // (frozen, not cleared) so the final tally stays on screen — the next
    // START zeroes them again. Only the per-cycle participation flags clear
    // here, so the next cycle can count each cell again.
    cellDischargedThisCycle = new Array(CELL_COUNT).fill(false);
    cellChargedThisCycle = new Array(CELL_COUNT).fill(false);

    saveBalanceStats();

    renderCells();

    // Every way a cycle can end — settled, stopped by hand, or stopped by
    // STOP — passes through here, so the completed count is refreshed in
    // exactly one place.
    updateBalancingCycleStat();

    // Balancing buttons were removed — guard in case they're absent.
    const bStart = document.getElementById("balStartBtn");
    const bStop = document.getElementById("balStopBtn");
    if (bStart) { bStart.disabled = balancingLockedOut || balancerFaulted(); bStart.classList.remove("running"); }
    if (bStop) bStop.disabled = true;

    document.getElementById("balancingBox").style.display = "none";
    document.getElementById("etaBox").style.display = "none";

    showStatus("■ Balancing Stopped", "stop");

    logEvent("■ Balancing Stopped", "info");

    if (transmit) await sendSerialCommand("BALSTOP");

}

// "3m 20s", "45s" — never "0s", which reads as finished rather than
// nearly finished.
function formatDuration(seconds) {

    const total = Math.max(1, Math.ceil(seconds));

    const minutes = Math.floor(total / 60);

    const rest = total % 60;

    return minutes ? `${minutes}m ${rest}s` : `${rest}s`;

}

// Names the two cells discharging, the cell charging, and how long the
// balance has left to run at the configured Equalizing Current.
//
// Reads cellBalancing[], the same array that puts the "balancing" class
// on the cell cards, so the box and the grid can never disagree about
// which cells are balancing.
//
// Called every tick while balancing, so the display follows the
// voltages as cells settle and hand off to the next-highest.
function updateBalancingDisplay() {

    if (!balancingActive) return;

    const title = document.getElementById("balancingTitle");
    const list = document.getElementById("balancingList");
    const note = document.getElementById("balancingNote");

    if (!title || !list || !note) return;

    // A single-cell pack has nothing to balance against.
    if (cellVoltages.length < 2) {

        title.innerHTML = "⚖ BALANCING";

        list.innerHTML = "";

        note.innerHTML = "Needs at least 2 cells";

        return;

    }

    const startVoltage = parseFloat(document.getElementById("startVoltage").value);

    const discharging = cellBalancing
        .map((isBalancing, index) => (isBalancing ? index : -1))
        .filter(index => index !== -1);

    if (!discharging.length) {

        title.innerHTML = "⚖ BALANCING";

        list.innerHTML = "";

        // On a real device the pair comes from Docklight, so an empty pair
        // simply means "none sent yet" — not a mis-set threshold.
        if (!simulationEnabled) {

            note.innerHTML = "Send $BALCELL from Docklight to select cells";

            return;

        }

        // Simulation: three different reasons the auto-pick found nothing,
        // three different fixes. Collapsing them into one message sends you
        // looking in the wrong place.
        note.innerHTML = isNaN(startVoltage)
            ? "Set an Equalizing Starting Voltage"
            : bleedPerTick() <= 0
                ? "Set an Equalizing Current"
                : `No cell above ${startVoltage.toFixed(3)} V`;

        return;

    }

    const receiver = chargingCellIndex(discharging);

    const sender = discharging[0];

    title.innerHTML = "⚖ BALANCING";

    const rows = [
        `<span class="bal-dis">▼ Cell ${sender + 1} ${cellVoltages[sender].toFixed(3)} V</span>`
    ];

    if (receiver === -1) {

        // No receiver: the low cell is full, so the sender's charge is
        // dissipated. Saying so beats leaving a dangling arrow pointing
        // at a cell that isn't taking anything.
        rows.push(`<span class="bal-sep">↓ dissipated</span>`);

    }

    else {

        rows.push(`<span class="bal-sep">↓</span>`);

        rows.push(
            `<span class="bal-chg">▲ Cell ${receiver + 1} ${cellVoltages[receiver].toFixed(3)} V</span>`
        );

    }

    list.innerHTML = rows.join(" ");

    // The projection ran out but cells are still draining — the original
    // estimate was simply short. Re-project once, rather than parking on
    // "1s remaining" for the rest of the balance. Also project the moment
    // an estimate first becomes possible — a rate just got measured, or an
    // Equalizing Current was set after balancing already started — since in
    // that case there was never a deadline to expire.
    if (estimateBalanceSeconds() !== null &&
        (balanceDeadlineAt === null || balanceSecondsRemaining() === 0)) {

        resetBalanceEstimate();

    }

    const clock = balanceCompletionClock();

    // Show the clock time it should finish, not a countdown. No rate means
    // no honest estimate — say so rather than print a time that never
    // arrives. Where a time IS shown, name its source: a measured rate is
    // fact, a configured one is a guess.
    note.innerHTML = clock === null
        ? "Set an Equalizing Current to estimate"
        : `Completes at ${clock} ` +
          `(${balanceRateIsMeasured() ? "measured" : "from set current"})`;

    // Same completion time, mirrored under RUNNING TIME.
    const eta = document.getElementById("balanceEta");

    if (eta) eta.innerHTML = clock === null ? "--" : clock;

}

// ======================================
// FOOTER CLOCK
// ======================================

function formatDisplayDateTime(now) {

    const dateStr = now.toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric"
    });

    const timeStr = now.toLocaleTimeString("en-US");

    return dateStr + ", " + timeStr;

}

function updateFooterClock() {

    const now = new Date();

    const stamp = formatDisplayDateTime(now);

    document.getElementById("footerClock").innerHTML = stamp;

    document.getElementById("liveClock").innerHTML = stamp;

}

// ======================================
// LOGOUT
// ======================================

// Set while logging out so the serial read loop's finally doesn't fire its
// own "device disconnected → back to login" redirect while we're already
// heading there deliberately.
let loggingOut = false;

function showLogoutConfirm() {

    // Only offer the disconnect choice when there is actually a live device.
    const row = document.getElementById("logoutDisconnectRow");

    if (row) row.style.display = realDeviceConnected ? "flex" : "none";

    document.getElementById("logoutOverlay").classList.add("open");

}

function hideLogoutConfirm() {

    document.getElementById("logoutOverlay").classList.remove("open");

}

async function logout() {

    // If a device is connected and the user chose to disconnect it, close
    // the port cleanly before leaving. loggingOut keeps the read loop's
    // finally from racing us to login.html with a "disconnected" message.
    const chk = document.getElementById("logoutDisconnectChk");

    if (realDeviceConnected && chk && chk.checked) {

        loggingOut = true;

        await disconnectRealDevice();

    }

    localStorage.setItem("logoutMessage", "1");

    sessionStorage.removeItem("loggedIn");

    sessionStorage.removeItem("currentUser");

    window.location.href = "login.html";

}

document.addEventListener("DOMContentLoaded", () => {

    document.getElementById("cancelLogoutBtn").addEventListener("click", hideLogoutConfirm);

    document.getElementById("confirmLogoutBtn").addEventListener("click", logout);

});

// ======================================
// DEVICE DISCONNECT — RECONNECT OR LOGOUT
// ======================================
// When the real device drops out mid-session the read loop calls
// showDisconnectModal() (instead of bouncing straight to login), so the
// operator can choose to reconnect the hardware or log out.

function showDisconnectModal() {

    const overlay = document.getElementById("disconnectOverlay");

    if (overlay) overlay.classList.add("open");

}

function hideDisconnectModal() {

    const overlay = document.getElementById("disconnectOverlay");

    if (overlay) overlay.classList.remove("open");

}

async function reconnectRealDevice() {

    // ALWAYS ask which port, and open exactly the one chosen. This runs from
    // the Reconnect button click — a user gesture — so requestPort() is
    // allowed here.
    //
    // It used to throw the picker's answer away and then open whichever
    // authorised port happened to open first. So picking the board could
    // still land on a stale port from an earlier session: it opens, reports
    // "Connected", carries no data, and drops straight back to
    // "Device Disconnected".
    let chosen;

    try {

        chosen = await navigator.serial.requestPort();

    }

    catch (error) {

        // The user dismissed the port picker — leave the dialog up so they
        // can try again or log out.
        showStatus("Reconnect cancelled", "stop");

        return;

    }

    if (await connectToPort(chosen)) {

        hideDisconnectModal();

        showStatus("🔌 Device Reconnected — Live Hardware Data", "success");

        logEvent("🔌 Real Device Reconnected", "success");

    }

    else {

        showStatus("⚠ Could Not Open That Port — It May Be In Use By Docklight", "stop");

        logEvent("⚠ Reconnect Failed — Could Not Open The Selected Port", "error");

    }

}

async function logoutFromDisconnect() {

    // The device is already gone, so there is nothing to close cleanly —
    // just end the session and return to login. loggingOut guards against
    // any late read-loop teardown racing this navigation.
    loggingOut = true;

    localStorage.setItem("logoutMessage", "1");

    sessionStorage.removeItem("loggedIn");

    sessionStorage.removeItem("currentUser");

    window.location.href = "login.html";

}

document.addEventListener("DOMContentLoaded", () => {

    const reconnectBtn = document.getElementById("reconnectBtn");
    const disconnectLogoutBtn = document.getElementById("disconnectLogoutBtn");

    if (reconnectBtn) reconnectBtn.addEventListener("click", reconnectRealDevice);
    if (disconnectLogoutBtn) disconnectLogoutBtn.addEventListener("click", logoutFromDisconnect);

});

// ======================================
// EQUALIZATION FIELDS — PRESS ENTER TO SET
// (same effect as clicking SET, but silent)
// ======================================

document.addEventListener("DOMContentLoaded", () => {

    document.querySelectorAll(".eq-field input").forEach(input => {

        input.addEventListener("keydown", (e) => {

            if (e.key !== "Enter") return;

            e.preventDefault();

            const button = input.closest(".eq-card").querySelector(".eq-setbtn");

            if (button) button.click();

        });

    });

});

// ======================================
// EQUALIZATION SLIDERS — hardware-knob
// feel, kept in sync with the number
// fields in both directions
// ======================================

function bindSlider(numberId, sliderId) {

    const number = document.getElementById(numberId);
    const slider = document.getElementById(sliderId);

    if (!number || !slider) return;

    // Match the slider to whatever the number field already holds
    // (e.g. a value restored from localStorage) before wiring sync.
    const initial = parseFloat(number.value);

    if (!isNaN(initial)) slider.value = initial;

    slider.addEventListener("input", () => {

        number.value = slider.value;

    });

    number.addEventListener("input", () => {

        const value = parseFloat(number.value);

        if (!isNaN(value)) slider.value = value;

    });

}

document.addEventListener("DOMContentLoaded", () => {

    bindSlider("eqHigh", "eqHighSlider");
    bindSlider("eqLow", "eqLowSlider");
    bindSlider("startVoltage", "startVoltageSlider");
    bindSlider("diffLimit", "diffLimitSlider");
    bindSlider("currentLimit", "currentLimitSlider");
    bindSlider("stringCount", "stringCountSlider");
    bindSlider("ovProtection", "ovProtectionSlider");
    bindSlider("ovRecovery", "ovRecoverySlider");
    bindSlider("uvProtection", "uvProtectionSlider");
    bindSlider("pressureLimit", "pressureLimitSlider");
    bindSlider("balanceOnTime", "balanceOnTimeSlider");
    bindSlider("balanceOffTime", "balanceOffTimeSlider");
    bindSlider("overBalWarnLimit", "overBalWarnLimitSlider");

});

// ======================================
// INITIAL SETTINGS
// ======================================

window.onload = function () {

    document.getElementById("stopBtn").disabled = true;

    document.getElementById("timer").innerHTML = "00:00:00";

    document.getElementById("systemStatus").innerHTML = "";

    document.getElementById("spinner").style.display = "none";

    document.getElementById("runningLabel").style.display = "none";

};
