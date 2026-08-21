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

// Passive mode's real-hardware equivalent of manualBalancePair — set from a
// real board's own "BAL CELLS : C02 C08" status report (see
// detectPassiveBalCellsReport()), 0-based indices, [] when the board
// reports none currently balancing. null = nothing reported yet (real
// device Passive shows nothing discharging until the board's first
// report arrives, same as Active shows nothing until $BALCELL arrives).
let manualPassiveCells = null;

// True after a STOP, to keep balancing stopped even though Docklight keeps
// re-sending its balancing command every second. While set, incoming Docklight
// pairs are ignored so nothing restarts on its own — cleared again by START
// (or $BALSTART), which is the deliberate "go" the operator must give.
let manualBalanceBlocked = false;

// The last pair Docklight selected ({ sender, receiver }), remembered across a
// STOP so pressing START resumes exactly that balance without waiting for
// Docklight to re-send its command. null until Docklight names a pair.
let lastManualPair = null;

// How many times each cell has begun discharging, and begun charging.
// Counted on the rising edge only — a cell that discharges for 200 ticks
// has discharged once, not 200 times. Works identically for simulated
// and real data, since both drive cellBalancing[] the same way.
let cellDischargeCount = new Array(CELL_COUNT).fill(0);
let cellChargeCount = new Array(CELL_COUNT).fill(0);

// Per-cell tallies shown in the Cells popover. These rise on EVERY update a
// cell is actively charging / discharging (not just once per cycle like the
// counts above), so each cell's number keeps climbing while it works. Reset
// to 0 on START; only count while the BMS is running.
let cellChargeTicks = new Array(CELL_COUNT).fill(0);
let cellDischargeTicks = new Array(CELL_COUNT).fill(0);

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

// "active" (cell-to-cell transfer, today's original behaviour) or
// "passive" (resistor bleed — no receiver, and every over-threshold cell
// can discharge at once). Chosen at login, remembered like the baud
// rate, and still changeable from the dashboard via setBalancingMode()
// — but only while balancing is stopped, so the algorithm never changes
// out from under a transfer/bleed already in progress.
let balancingMode = (function () {

    try { return localStorage.getItem("bmsBalancingMode") === "passive" ? "passive" : "active"; }
    catch (e) { return "active"; }

})();

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
// BALANCE_OFF_S, and repeats. During the rest the dashboard shows idle but the
// session stays active, and the completion-time estimate stretches the pure
// balancing time by these rest gaps. (40 s on, 5 s off.)
const BALANCE_ON_S = 40;
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

// When the current balancing session's duty-cycle timing began. Used to work
// out whether we are in an ON (balancing) or OFF (resting) part of the cycle.
// null when not balancing.
let balancePhaseStartAt = null;

// Passive mode only: EVERY cell currently over the Starting Voltage gets its
// own independently-timed bleed — no cap on how many run at once. Keyed by
// cell index; entries look like { phase: "on"|"off", phaseStartAt,
// phaseDurationS }. A cell with no entry here is not currently eligible.
// Re-evaluated every tick by advancePassiveCellTimers(), which both adds a
// newly-eligible cell and drops one that has settled — so the set of
// balancing cells always reflects each cell's CURRENT voltage, not just
// whichever cells were highest when balancing started.
let passiveCellTimers = {};

// Fires the "did it finish by the estimated time?" check once per balancing
// session — the moment the pack actually reaches balanced. Reset on start.
let balanceCompletionChecked = false;

// The high−low spread at the moment balancing started, so the graph's balancing
// progress bar can show how far the pack has closed toward balanced. null when
// not balancing.
let balanceStartSpread = null;

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

// com0com virtual ports can raise a transient "BreakError: Break received"
// (a line glitch, often around a write) that errors the read stream. That is
// NOT a real unplug, so instead of tearing down the session we reopen the same
// port and keep going — up to a few quick retries, reset whenever a good frame
// arrives.
let breakRecoveryCount = 0;
const MAX_BREAK_RECOVERY = 5;

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

    // Two-line badge sub-text: baud when a port is open, else "Not connected".
    const sub = document.getElementById("deviceFreshness");
    if (sub && !sub.textContent.trim().toLowerCase().includes("stale")) {
        sub.textContent = connected ? (savedBaudRate() + " baud") : "Not connected";
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

    let readLoopError = null;

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

        readLoopError = error;

    }

    finally {

        if (realReader) realReader.releaseLock();

        await inputClosed.catch(() => {});

        // Keep the port object so a transient break can reopen the SAME one.
        const closingPort = realPort;

        if (closingPort) await closingPort.close().catch(() => {});

        realPort = null;

        setDeviceStatus(false);

        // A deliberate logout is already navigating to login — don't fire a
        // "device disconnected" log/redirect on top of it.
        if (loggingOut) return;

        // A com0com "BreakError" (and similar framing/parity/overrun line
        // glitches) is NOT a real unplug — reopen the same port and carry on,
        // so a write-triggered break doesn't kill the whole session. Bail to
        // the normal disconnect flow only after too many breaks in a row.
        const name = readLoopError && readLoopError.name ? readLoopError.name : "";
        const msg = (readLoopError && readLoopError.message ? readLoopError.message : "").toLowerCase();
        const isLineGlitch = name === "BreakError" || /break|framing|parity|overrun/i.test(msg);

        if (isLineGlitch && closingPort && breakRecoveryCount < MAX_BREAK_RECOVERY) {

            breakRecoveryCount++;

            logEvent(`⚠ Serial Line Break — Reconnecting (${breakRecoveryCount}/${MAX_BREAK_RECOVERY})`, "error");

            // Brief pause so the OS releases the port, then reopen the same one.
            // If the reopen fails, don't die silently — fall back to the normal
            // disconnect flow so the operator is told and the session stops.
            setTimeout(async () => {

                const reconnected = await connectToPort(closingPort);

                if (!reconnected && !loggingOut) {

                    logEvent("🔌 Real Device Disconnected — Reconnect Failed", "error");

                    if (running) {

                        logEvent("⛔ BMS Auto-Stopped — USB Device Disconnected", "error");
                        stopBMS();

                    }

                    showDisconnectModal();

                }

            }, 300);

            return;

        }

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

    // Prefer a COMPLETE pair — "BAL : CELL03 -> CELL06" — with BOTH cell
    // numbers present. The stream is continuous (cell frames + a BAL command
    // repeated every second), so the rolling window regularly cuts a repeat in
    // half. Scanning globally and taking the LAST complete pair means a cut
    // copy of the same command can never be read instead of a whole one.
    //
    // The trailing "(?=\D)" on the receiver number is essential: without it, a
    // window that cuts "CELL06" down to "CELL0" would read the receiver as 0
    // (which becomes -1 / "dissipated"), and a cut of "CELL03" to "CELL0" would
    // read a sender of 0 ("Invalid Balancing Cell — 0"). Requiring a non-digit
    // AFTER the number proves the number finished arriving; a number cut off at
    // the end of the buffer simply waits for the next chunk to complete.
    const pairRe = /\bBAL\s*[:=]?\s*(?:C(?:ELL)?\s*[:=]?\s*)?(\d+)\s*[-,>]+\s*(?:C(?:ELL)?\s*[:=]?\s*)?(\d+)(?=\D)/ig;

    let m, lastPair = null;

    while ((m = pairRe.exec(rawStatusTail)) !== null) lastPair = m;

    if (lastPair) {

        console.log("[BAL parse] pair sender=" + lastPair[1] + " receiver=" + lastPair[2] + " (v2 parser)");

        setManualBalancePair(
            parseInt(lastPair[1], 10) - 1,
            parseInt(lastPair[2], 10) - 1
        );

        // Blank every complete pair so none re-fires; a half-arrived repeat is
        // left untouched to finish assembling on the next chunk.
        rawStatusTail = rawStatusTail.replace(pairRe, "·");

        return;

    }

    // No complete pair anywhere — treat it as a genuine single-cell
    // (dissipate) command ONLY when the cell number is complete (a non-digit
    // follows, so it wasn't cut mid-number) and is NOT followed by an arrow.
    // The "(?=\D)" stops a truncated "CELL0" from reading as cell 0; the
    // negative lookahead stops a truncated pair like "BAL : CELL03 -> CE" from
    // being misread as "discharge cell 3 only" and wrongly dropping the
    // receiver.
    const single = rawStatusTail.match(
        /\bBAL\s*[:=]?\s*(?:C(?:ELL)?\s*[:=]?\s*)?(\d+)(?=\D)(?![\s\d]*[-,>])/i
    );

    if (single) {

        setManualBalancePair(parseInt(single[1], 10) - 1, -1);

        rawStatusTail = rawStatusTail.replace(single[0], "·");

    }

}

// Real Passive hardware reports which cells it's currently balancing
// directly, as a plain status line — "BAL CELLS : C02 C08" (space-separated
// "Cnn" labels) or "BAL CELLS : NONE" when idle — the multi-cell equivalent
// of Active's single-pair "$BALCELL" command, and the counterpart to what
// formatBalanceReport() sends out in Passive mode. Drives
// manualPassiveCells so balancingCellIndices() can show the real board's
// own reported set, instead of the dashboard's own simulated guess (which
// never applies to genuine real-device data). Only acted on in Passive
// mode — this line only means something when the board is actually
// running as a passive balancer.
function detectPassiveBalCellsReport() {

    if (balancingMode !== "passive") return;

    const match = rawStatusTail.match(/BAL\s*CELLS\s*:\s*(NONE|(?:C\s*\d+\s*)+)/i);

    if (!match) return;

    const listText = match[1];

    manualPassiveCells = /^NONE$/i.test(listText.trim())
        ? []
        : Array.from(listText.matchAll(/\d+/g)).map(n => parseInt(n[0], 10) - 1);

    rawStatusTail = rawStatusTail.replace(match[0], "·");

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

    // A real Passive board's own "BAL CELLS : C02 C08" status report — see
    // detectPassiveBalCellsReport() for why this needs to be separate from
    // the single-pair parser below.
    detectPassiveBalCellsReport();

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
// fine. When a field differs, the device's value is treated as the source of
// truth and written into the dashboard field (input + slider, saved; the grid
// resizes for CELLS), so the dashboard is brought into line with the board.

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
    //   $BAL : CELL03 -> CELL06#     $BAL : C3 -> C7#
    //   $BALCELL:3,6#      $BALCELL:3->6#      $BAL:3,6#
    //   $BALCELL:3#  /  $BAL:CELL03#   -> discharge only, no receiver
    // The cell prefix may be "CELL", the short "C", or nothing at all, and the
    // separator may be ":", "=", ",", "->" etc.
    const balCellMatch = cmd.match(
        /^BAL\s*[:=]?\s*(?:C(?:ELL)?\s*[:=]?\s*)?(\d+)(?:\s*[-,>]+\s*(?:C(?:ELL)?\s*[:=]?\s*)?(\d+))?$/
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

    // A good frame got through — clear the break-retry count so an occasional
    // future glitch still gets its full allowance of reconnects.
    breakRecoveryCount = 0;

    // Paint the new readings NOW, not on the next live tick. Cell frames can
    // arrive several times a second — much faster than the 1.5s tick — so
    // rendering only on the tick "samples" the stream and skips frames: three
    // different voltage sets cycling in Docklight would look like only one or
    // two ever display. Rendering here shows every frame as it arrives.
    renderCells();
    updateStats(false);
    checkWarnings();

    if (graphOpen) renderGraph();

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
let currentLogPack = null;
let logQueue = Promise.resolve();

// The pack number typed into the dashboard (real-device use). It is baked into
// the CSV filename so every pack's readings are saved to their own file.
// Sanitised to safe filename characters.
function getPackNo() {

    const el = document.getElementById("packNo");
    const raw = el ? el.value.trim() : "";

    return raw.replace(/[^A-Za-z0-9_-]/g, "");

}

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
    const packNo = getPackNo();

    if (logFileHandle && currentLogDate === dateStr && currentLogDataSource === source && currentLogPack === packNo) return true;

    // File is named simply by the pack number — e.g. "Pack1.csv". The date and
    // time are still recorded inside the file (the Date/Time columns of every
    // row), so nothing is lost by keeping the name short. With no pack number
    // typed, fall back to the descriptive default so logging still works.
    const fileName = packNo ? `Pack${packNo}.csv` : `BMS_Log_${source}_${dateStr}.csv`;

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
        currentLogPack = packNo;

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

    // If the calendar day changed, the data source changed (real device vs
    // Automatic Values), or the pack number changed, roll over to the right
    // file before writing the next row — each must have its own file.
    if (currentLogDate !== todayDateStr() || currentLogDataSource !== currentDataSourceLabel() || currentLogPack !== getPackNo()) {

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
    "eqHigh", "eqLow", "diffLimit", "currentLimit",
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

    // The completion time is FIXED once a balance starts — changing the
    // Equalizing Current / Starting Voltage / duty times mid-balance does NOT
    // move COMPLETES AT. The new values apply to the NEXT balance. (So there is
    // deliberately no re-projection here.)

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

    // Restore the last Docklight-selected balancing pair so START can resume
    // it even after a page reload.
    try {

        const savedPair = localStorage.getItem("bmsLastManualPair");
        if (savedPair) lastManualPair = JSON.parse(savedPair);

    }

    catch (e) { /* corrupt/blocked storage — start with no remembered pair */ }

    // Restore the saved pack number and keep it saved as it's edited, so it
    // survives reloads and the CSV files stay named by pack.
    const packInput = document.getElementById("packNo");

    if (packInput) {

        const savedPack = localStorage.getItem("bmsPackNo");
        if (savedPack) packInput.value = savedPack;

        packInput.addEventListener("input", () => {
            localStorage.setItem("bmsPackNo", packInput.value);
        });

    }

    renderActivityLog();

    createCells();
    updateFooterClock();
    setInterval(updateFooterClock, 1000);

    // Its own 1s timer, separate from the 1.5s liveDataTick — so the "last
    // frame Ns ago" counter advances through every whole second (2, 3, 4,
    // 5...) instead of skipping some numbers, which is what rounding a
    // 1.5s-spaced sample to the nearest second would otherwise do.
    setInterval(updateDeviceFreshness, 1000);

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

    // Passive's per-cell ON/OFF phase timers get their own faster interval,
    // separate from the 1.5s liveDataTick — so a 5s configured break is
    // detected within ~100ms of the real 5s mark instead of overshooting
    // to as much as 6.5s (a full liveDataTick period late). This is a poll,
    // not a precisely-scheduled timer, so a small overshoot (well under a
    // second) is inherent no matter how tight the interval — this just
    // shrinks it, it can't reach exactly 0. The actual discharge/voltage
    // change still only happens on liveDataTick's own cadence via
    // applyActiveBalancing(); this just keeps the phase (on/off) itself
    // accurate to the configured duration.
    setInterval(advancePassiveCellTimers, 100);

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

        const div = document.createElement("div");

        div.className = "cell";
        div.id = `cellCard${i}`;
        // No per-cell accent colour — every cell looks identical at the
        // start; only the charging / discharging state recolours a cell
        // (handled by the .charging / .balancing class overrides in CSS).

        div.innerHTML = `

            <div class="cell-badge" id="cellBadge${i}"></div>

            <span class="cell-num">Cell ${i}</span>

            <div class="cell-cyl" id="cellGauge${i}">
                <div class="cell-cyl-body">
                    <div class="cyl-head">
                        <span class="cyl-cellno">CELL ${String(i).padStart(2, "0")}</span>
                        <span class="cyl-status" id="cellStatus${i}">✓ NORMAL</span>
                    </div>
                    <div class="cyl-vrow"><span class="cell-voltage" id="cellVal${i}">0.000</span><span class="cyl-unit">V</span></div>
                    <div class="cyl-scale">
                        <div class="cyl-track"><div class="cell-battery-fill" id="cellFill${i}"></div></div>
                        <div class="cyl-ticks"><span>3.0</span><span>3.6</span><span>4.2</span></div>
                    </div>
                </div>
                <span class="cyl-cap cyl-cap-r"></span>
            </div>

            <div class="cell-state" id="cellState${i}"></div>

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

            // A failed write means Docklight receives nothing. With com0com a
            // "BreakError: Break received" here is a virtual-port line condition
            // (usually the pair's "emulate baud rate" setting), not a dashboard
            // bug — flag it clearly so it isn't mistaken for a silent no-op.
            console.warn("⚠ Serial WRITE failed — Docklight will NOT receive this frame:", error && error.name, error && error.message);

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

    // Make the "why nothing was sent" case LOUD instead of a silent return, so
    // it's obvious in the console why Docklight receives nothing: either no
    // real port is connected, or the connected port exposes no writable stream.
    if (!realPort) {

        console.warn(`⚠ Cannot send "${command}" — NO real serial port connected (dashboard is on simulated data or the port never opened). Connect to Docklight's com0com partner port.`);

        return;

    }

    if (!realPort.writable) {

        console.warn(`⚠ Cannot send "${command}" — the connected port has NO writable stream (read-only). Info:`, realPort.getInfo && realPort.getInfo());

        return;

    }

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

    // Duty cycle: during the OFF rest nothing is balancing (the session stays
    // active). Report nothing discharging so the cells, badges, box and button
    // all read idle — then balancing resumes when the ON part comes back.
    if (balancerResting()) return [];

    // Docklight named the pair — use its discharging cell.
    if (manualBalancePair) {

        // On a REAL device the board owns the transfer: show the selected
        // sender until Docklight ends it with $BALSTOP.
        if (!simulationEnabled) return [manualBalancePair.sender];

        // In simulation the dashboard IS draining the cell, so the sender
        // must drop out once it reaches the Starting Voltage — exactly like
        // the auto-pick below. Without this, balancingCellIndices() never
        // empties, finishBalancingIfSettled() never fires, balancingActive
        // stays stuck true, and the drift walk (suppressed while balancing)
        // freezes every Remote value until a $BALSTOP arrives.
        const startV = parseFloat(document.getElementById("eqLow").value);

        // No threshold set — a simulated balance has no target to settle at,
        // and applyActiveBalancing() moves nothing either. Returning the sender
        // here would leave balancingActive stuck true and freeze the drift, so
        // report nothing discharging and let it settle instead.
        if (isNaN(startV)) return [];

        return cellVoltages[manualBalancePair.sender] > startV
            ? [manualBalancePair.sender]
            : [];

    }

    // Real Passive hardware reports its own multi-cell set directly (see
    // detectPassiveBalCellsReport()) — same priority as manualBalancePair
    // above, just for Passive's "several cells at once" shape instead of a
    // single pair. Checked before the general real-device gate below,
    // which would otherwise always report nothing for a real device.
    if (!simulationEnabled && balancingMode === "passive" && manualPassiveCells !== null) {

        return manualPassiveCells.filter(i => i >= 0 && i < CELL_COUNT);

    }

    // On a REAL device the balancing pair is selected ONLY from Docklight
    // ($BALCELL). The dashboard never auto-picks cells for a real board — so
    // pressing START does not choose a pair; it waits for $BALCELL. (In
    // simulation / Remote Monitor the dashboard IS the board, so it still
    // auto-picks highest→lowest below.)
    if (!simulationEnabled) return [];

    if (cellVoltages.length < 2) return [];

    // Passive: every eligible cell bleeds at once, each on its own timer —
    // maintained per-tick by advancePassiveCellTimers(); this just reports
    // whichever of them are currently in their ON phase.
    if (balancingMode === "passive") {

        return Object.keys(passiveCellTimers)
            .map(Number)
            .filter(i => passiveCellTimers[i].phase === "on");

    }

    const startVoltage = parseFloat(document.getElementById("eqLow").value);

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

    // Full "CELLnn" labels, matching the "$CELLnn:####mV#" frames the device
    // sends.
    const cellName = index => "CELL" + String(index + 1).padStart(2, "0");

    // Passive's report format matches the real 16S passive-balancer status
    // text exactly (confirmed against a real Docklight capture): a header
    // naming the string size, a MAX/MIN/DIFF line, STATE + channel count,
    // a plain space-separated cell list (never an arrow — there's no
    // receiver), and the balancer hardware's own fault state. Kept
    // entirely separate from Active's format below so Active's
    // Docklight-side behaviour (and anything parsing it) is untouched.
    if (balancingMode === "passive") {

        const maxV = Math.max(...cellVoltages);
        const minV = Math.min(...cellVoltages);
        const maxIndex = cellVoltages.indexOf(maxV);
        const minIndex = cellVoltages.indexOf(minV);

        const faults = [];
        if (mcp1Failed) faults.push("MCP1");
        if (mcp2Failed) faults.push("MCP2");

        const balancerLine = faults.length
            ? `BALANCER : ${faults.join("+")} FAIL`
            : "BALANCER : NORMAL";

        return [
            `--- ${CELL_COUNT}S PASSIVE BALANCER STATUS ---`,
            `MAX : ${cellLabel(maxIndex)} = ${toMillivolts(maxV)}mV | MIN : ${cellLabel(minIndex)} = ${toMillivolts(minV)}mV | DIFF : ${toMillivolts(maxV - minV)}mV`,
            `STATE : ${discharging.length ? "ON" : "IDLE"} | ACTIVE CHANNELS : ${discharging.length}`,
            rule,
            `BAL CELLS : ${discharging.length ? discharging.map(cellLabel).join(" ") : "NONE"}`,
            rule,
            balancerLine
        ].join("\r\n") + "\r\n";

    }

    // Before START (or after STOP, or with no cell selected yet) nothing is
    // discharging — report "BAL : IDLE", with NO cell number. The cell only
    // shows once balancing is actually running on a selected cell.
    if (!discharging.length) {

        return [rule, "BAL : IDLE", rule].join("\r\n") + "\r\n";

    }

    const lines = [rule];

    const sender = discharging[0];

    const receiver = chargingCellIndex(discharging);

    // "BAL : CELL03 -> CELL06". The per-cell DISCHARGING / CHARGING voltage
    // lines and the "EST : COMPLETES AT" line are deliberately not sent. No
    // receiver means the low cell is already full and the sender's charge
    // is being dissipated instead.
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

function sendBalanceReport(force = false) {

    if (!realPort || !realPort.writable) return;

    // On the real-device path the board is already streaming cell data IN,
    // so echoing a full report back every tick overruns the port. Throttle
    // it to once every 2 seconds — often enough to watch in Docklight, slow
    // enough to keep the port from saturating. In simulation the dashboard
    // IS the source, so it streams every tick. force=true (a START / STOP /
    // pair change) bypasses the throttle so the new status reaches Docklight
    // immediately rather than up to 2 s later.
    if (!simulationEnabled && !force) {

        const now = Date.now();

        if (now - lastBalanceReportAt < 2000) return;

    }

    lastBalanceReportAt = Date.now();

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
    // blocked by a leftover flag.
    balancingLockedOut = false;

    // Per-cell ▼/▲ tallies reset on every START — each run counts from zero
    // rather than accumulating across the day. Saved so a reload keeps them
    // zeroed until cells charge/discharge again this run.
    cellDischargeCount = new Array(CELL_COUNT).fill(0);
    cellChargeCount = new Array(CELL_COUNT).fill(0);

    // Popover per-cell tallies also start fresh each run.
    cellChargeTicks = new Array(CELL_COUNT).fill(0);
    cellDischargeTicks = new Array(CELL_COUNT).fill(0);

    saveBalanceStats();

    updateBalancingCycleStat();

    document.getElementById("timer").innerHTML = "00:00:00";

    timer = setInterval(updateTimer, 1000);

    if (transmit) await sendSerialCommand("START");

    // START also starts balancing (there is no separate balancing button) and
    // STOP stops it — see stopBMS below. Always call startBalancing: it starts
    // a fresh balance when idle, and when a Docklight pair is already live it
    // just re-sends "$BALSTART#" so START always signals the device to start.
    await startBalancing(transmit);

    // Push the balancing status to Docklight right away — the pair if one is
    // active, or "BAL : IDLE" if none — so pressing START always produces an
    // immediate BAL line in Docklight instead of waiting for the next tick.
    sendBalanceReport(true);

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

    // Passive's per-cell phase timers are advanced on their own faster
    // interval now (see the setInterval near the bootstrap code) so ON/OFF
    // transitions land close to their configured duration instead of
    // overshooting by up to a full 1.5s tick. By the time
    // applyActiveBalancing()/balancingCellIndices() read the discharging
    // set below, it already reflects the latest phase.
    applyActiveBalancing();

    // Re-project COMPLETES AT — see maybeReestimateOnIdle() for exactly
    // when this actually re-triggers (differs for simulation vs. real).
    maybeReestimateOnIdle();

    // Compare the actual finish against the estimated COMPLETES AT time and
    // report on-time / late — must run BEFORE finishBalancingIfSettled(), which
    // may stop the session (and clear balanceDeadlineAt) on the same tick.
    checkBalanceCompletionVsEstimate();

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

    // Sample the pack max/avg/min for the graph's Trend view, then redraw the
    // graph if its modal is open.
    recordGraphHistory();
    if (graphOpen) renderGraph();

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

    // Never in Remote Monitor / Automatic mode. The snapshot restore is only
    // for keeping a REAL board's last readings across a refresh; running it in
    // Automatic mode could restore a stale real-data snapshot from an earlier
    // session in the same tab AND flip simulationEnabled off — which freezes
    // the simulated values (no drift, no board). Simulated data regenerates on
    // its own, so there is nothing to restore here anyway.
    if (usingAutomaticValues()) return;

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

    // Passive balancing bleeds excess through a resistor — there is no
    // receiver, ever. Even a Docklight $BALCELL naming one is treated as
    // discharge-only while in Passive mode.
    if (balancingMode === "passive") return -1;

    if (!discharging.length) return -1;

    // Docklight named the pair — use its receiving cell (-1 when it gave
    // only a discharging cell, i.e. dissipate rather than transfer).
    if (manualBalancePair) return manualBalancePair.receiver;

    // Real hardware only ever connects a cell to an immediate physical
    // neighbor — confirmed from a real Docklight trace ("BAL : C6 -> C7",
    // never the pack's global lowest cell). So the receiver is whichever of
    // the sender's neighbor(s) reads lower, not Math.min(...cellVoltages)
    // anywhere in the pack. An end cell (index 0 or CELL_COUNT-1) has only
    // one neighbor.
    const sender = discharging[0];

    const neighbors = [sender - 1, sender + 1].filter(i => i >= 0 && i < CELL_COUNT);

    if (!neighbors.length) return -1;

    const receiverIndex = neighbors.reduce((lowest, i) =>
        cellVoltages[i] < cellVoltages[lowest] ? i : lowest
    );

    // Charge only ever flows high -> low. If even the lower neighbor isn't
    // actually below the sender, there's nowhere for it to go — dissipate
    // instead of "charging" a cell in the wrong direction. (Not gated on
    // the Starting Voltage threshold itself: with only 1-2 candidate
    // neighbors to choose from, a neighbor sitting above that threshold is
    // still a perfectly good receiver as long as it's lower than the
    // sender — applyActiveBalancing() separately caps how much it can
    // actually gain, so it can never be pushed higher than the threshold.)
    if (cellVoltages[receiverIndex] >= cellVoltages[sender]) return -1;

    return receiverIndex;

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

    // Past a minute, show minutes + seconds ("2m 5s ago") rather than a
    // long raw second count ("125s ago") that's harder to read at a glance.
    let ago;

    if (secondsAgo < 1) {

        ago = "just now";

    } else if (secondsAgo < 60) {

        ago = Math.round(secondsAgo) + "s ago";

    } else {

        const totalSeconds = Math.round(secondsAgo);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;

        ago = `${minutes}m ${seconds}s ago`;

    }

    el.textContent = `· last frame ${ago}`;

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

    // Completion time is built from four things:
    //   1. the Equalizing Current      → how fast a cell drains (the rate)
    //   2. the balancing ON time (40 s) → duty cycle
    //   3. the interval OFF time (5 s)  → duty cycle
    //   4. the HIGH cell's distance above the Starting Voltage → how much
    //      there is to close

    // 1. Rate the balancer drains at, straight from the Equalizing Current.
    const current = parseFloat(document.getElementById("currentLimit").value);

    if (isNaN(current) || current <= 0) return null;

    const rate = (current * 0.002) / (TICK_MS / 1000);   // volts per second

    if (cellVoltages.length < 2) return null;

    const maxV = Math.max(...cellVoltages);

    // No readings yet (every cell 0 V) — nothing to estimate.
    if (maxV <= 0) return null;

    const startVoltage = parseFloat(document.getElementById("eqLow").value);

    if (isNaN(startVoltage)) return null;

    // 4. Balancing (either mode) only ever brings the HIGH cell(s) down to
    // the Starting Voltage — it never raises the low cell to meet them
    // (Passive can't transfer charge at all; Active's receiver is capped
    // at the Starting Voltage too). So what's actually being closed is the
    // highest cell's distance above that target, NOT the pack's max-min
    // spread — using max-min hugely overstates the time whenever the low
    // cell sits well below the target, which it usually does.
    const difference = maxV - startVoltage;

    if (difference <= 0) return null;

    // Pure balancing time if the balancer ran non-stop.
    //
    // Passive can run any number of cells at once (no cap), so it closes the
    // same total excess faster the more cells are currently eligible — a
    // rough approximation using the CURRENT count, same spirit as the rest
    // of this estimate, not an exact model of the per-cell scheduler.
    const passiveConcurrency = Math.max(1, balancingCellIndices().length);

    const pureSeconds = balancingMode === "passive"
        ? (difference / rate) / passiveConcurrency
        : difference / rate;

    // 2 & 3. Duty cycle: balance for ON seconds, rest for OFF seconds,
    // repeating (40 s / 5 s from EQ Settings). Add one OFF gap after each full
    // ON block but the last, so the wall-clock finish time includes the rests.
    // Passive has no single fixed ON time (each cell tapers on its own), so a
    // representative burst length is used here — the taper evaluated at the
    // current highest cell, same formula advancePassiveCellTimers() uses per
    // cell.
    const onS = balancingMode === "passive"
        ? passiveOnSecondsForVoltage(maxV, startVoltage)
        : balanceOnSeconds();

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

// True during the OFF part of the duty cycle — the balancer is mid-session but
// resting, so no charge moves and the dashboard shows idle, WITHOUT the session
// stopping. Each cycle is ON seconds balancing then OFF seconds resting,
// repeating from when balancing started.
//
// Active mode: unchanged — one shared on/off timer for the single sender,
// exactly as before. Passive mode: there is no single session-wide rest —
// every eligible cell keeps its own timer, so "resting" here means "at
// least one cell currently has a timer, but none of them are in their ON
// phase right now" — a genuine, temporary pause. Critically, this is NOT
// the same as passiveCellTimers being completely EMPTY: an empty set means
// nothing is eligible at all anymore (the pack finished, or nothing was
// ever above threshold), which is a real completion finishBalancingIfSettled()
// needs to see, not a "rest" it should keep waiting through forever. A live
// Docklight-named pair is never treated as resting in Passive mode — the
// hardware is driving it directly, not the auto-pick scheduler.
function balancerResting() {

    if (!balancingActive) return false;

    if (balancingMode === "passive") {

        if (manualBalancePair) return false;

        const timers = Object.values(passiveCellTimers);

        if (!timers.length) return false;

        return !timers.some(t => t.phase === "on");

    }

    if (balancePhaseStartAt === null) return false;

    const onS = balanceOnSeconds();
    const offS = balanceOffSeconds();

    if (offS <= 0) return false;

    const elapsed = (Date.now() - balancePhaseStartAt) / 1000;

    const position = elapsed % (onS + offS);

    return position >= onS;

}

// Passive mode's two-stage ON-burst length for ONE cell — a clean step,
// not a continuous taper:
//   Stage 1 (voltage >= Starting Voltage + Starting Voltage/50, i.e. a
//            fixed 2% margin above the target): 40s ON / configured OFF.
//   Stage 2 (below that margin, but still above the Starting Voltage):
//            10s ON / configured OFF.
// Each cell's timer in advancePassiveCellTimers() evaluates this fresh
// each time a new ON burst begins, so a cell can start a session in Stage
// 1 and drop into Stage 2 partway through settling, as its voltage falls.
function passiveStageBoundary(startVoltage) {

    return startVoltage + (startVoltage / 50);

}

// 1 = still meaningfully above target (40s bursts), 2 = close to target
// (10s bursts). Used both to pick the burst length and to label which
// stage a discharging cell is in on the dashboard.
function passiveStageForVoltage(voltage, startVoltage) {

    return voltage >= passiveStageBoundary(startVoltage) ? 1 : 2;

}

function passiveOnSecondsForVoltage(voltage, startVoltage) {

    return passiveStageForVoltage(voltage, startVoltage) === 1 ? 40 : 10;

}

// Advances Passive mode's per-cell bleed timers by one tick. No cap on how
// many cells run at once — normally EVERY cell currently over the Starting
// Voltage gets (or keeps) its own on/off timer, and a cell that drops out
// of eligibility (settled back to the threshold) loses its timer
// immediately, exactly like a slot that's no longer needed.
//
// Two-stage priority, checked in order — a cell only ever balances at the
// highest priority level the PACK currently has anything eligible at.
// Eligibility is based purely on the Equalizing Starting Voltage (and the
// Stage 1/2 boundary derived from it) — an Over-Voltage-faulted cell is
// NOT given special exclusive priority; it's just evaluated the same as
// any other cell by voltage, so it balances ALONGSIDE other Stage 1 cells
// rather than blocking them. (The red "OVER VOLTAGE" badge itself is
// unaffected — this only concerns which cells the scheduler picks.)
//   1. Stage 1 (some cell is still >= the Stage 1/2 boundary — see
//      passiveStageBoundary()): ONLY Stage 1 cells balance. Stage 2 cells
//      (below the boundary, still above Starting Voltage) wait their turn.
//   2. Stage 2 (no cell left in Stage 1): normal — every remaining cell
//      above the Starting Voltage balances (they're all Stage 2 by
//      definition at this point).
// Active mode is unaffected — this staging is Passive-only.
//
// This re-checks every cell's CURRENT value every tick, so a cell that
// only just became eligible (or ineligible, e.g. the last Stage 1 cell
// just finished) is picked up on the very next tick — there's no
// "reserved" cell blocking anything out.
// A live Docklight-named pair (manualBalancePair) bypasses this scheduler
// entirely — the hardware is driving that cell directly.
function advancePassiveCellTimers() {

    if (!balancingActive || balancingMode !== "passive" || manualBalancePair || !simulationEnabled) {

        passiveCellTimers = {};

        return;

    }

    const startVoltage = parseFloat(document.getElementById("eqLow").value);
    const now = Date.now();

    if (isNaN(startVoltage)) {

        passiveCellTimers = {};

        return;

    }

    // Stage gate, computed once for the whole pack.
    const stage1Boundary = passiveStageBoundary(startVoltage);
    const anyStage1 = cellVoltages.some(v => v >= stage1Boundary);

    for (let i = 0; i < CELL_COUNT; i++) {

        const t = passiveCellTimers[i];

        const eligible = anyStage1
            ? cellVoltages[i] >= stage1Boundary
            : cellVoltages[i] > startVoltage;

        // Not currently eligible — either settled, never qualified, or
        // paused by the Stage 1/2 priority gate above. Drop its timer so
        // it stops being reported as discharging.
        if (!eligible) {

            if (t) delete passiveCellTimers[i];

            continue;

        }

        // Newly eligible — start a fresh ON burst timed from its current
        // voltage.
        if (!t) {

            passiveCellTimers[i] = {
                phase: "on",
                phaseStartAt: now,
                phaseDurationS: passiveOnSecondsForVoltage(cellVoltages[i], startVoltage)
            };

            continue;

        }

        const elapsed = (now - t.phaseStartAt) / 1000;

        if (elapsed < t.phaseDurationS) continue;

        if (t.phase === "on") {

            const offS = balanceOffSeconds();

            if (offS <= 0) {

                // No configured rest — stay on, just re-time the next burst.
                t.phaseStartAt = now;
                t.phaseDurationS = passiveOnSecondsForVoltage(cellVoltages[i], startVoltage);

            } else {

                t.phase = "off";
                t.phaseStartAt = now;
                t.phaseDurationS = offS;

            }

        } else {

            // TEMP DIAGNOSTIC — fires only once per break (not per-tick), when
            // a break actually ends, showing how long it really lasted vs.
            // the configured Balancing OFF Time. Remove once confirmed fixed.
            console.log(`[break] Cell ${i + 1}: break lasted ${elapsed.toFixed(1)}s (configured ${t.phaseDurationS}s)`);

            t.phase = "on";
            t.phaseStartAt = now;
            t.phaseDurationS = passiveOnSecondsForVoltage(cellVoltages[i], startVoltage);

        }

    }

    // Drop any leftover timers for cell indices a String Number resize has
    // since removed — harmless to skip most ticks, cheap to check.
    for (const key in passiveCellTimers) {

        if (Number(key) >= CELL_COUNT) delete passiveCellTimers[key];

    }

}

// Takes a fresh projection of when the balance will finish. Called at
// BALANCING START and whenever the Equalizing Current or Starting
// Voltage changes — never per tick on its own (see maybeReestimateOnIdle()
// for what re-triggers it).
function resetBalanceEstimate() {

    const seconds = estimateBalanceSeconds();

    balanceDeadlineAt = seconds === null ? null : Date.now() + (seconds * 1000);

    // Remember the imbalance this projection was built from, so the idle
    // re-projection only fires when it moves meaningfully. Tracks the same
    // quantity estimateBalanceSeconds() actually times against — the high
    // cell's distance above the Starting Voltage — not the max-min spread.
    const startVoltage = parseFloat(document.getElementById("eqLow").value);

    lastEstimateDiff = (cellVoltages.length && !isNaN(startVoltage))
        ? (Math.max(...cellVoltages) - startVoltage)
        : null;

}

// The Max-cell-above-Starting-Voltage difference the current projection
// was built from.
let lastEstimateDiff = null;
const ESTIMATE_DIFF_STEP = 0.003;   // 3 mV — the "meaningful change" threshold

// Re-projects COMPLETES AT as new data comes in. For a SIMULATED session,
// only while the balancer is RESTING (idle) — the dashboard runs its own
// duty cycle, so mid-burst voltages are moving fast and re-projecting then
// would make the ETA jump around constantly. For a REAL DEVICE connection
// there is no dashboard-tracked rest phase to wait for at all (the board
// runs its own duty cycle, invisible to this scheduler) — so it checks
// every tick instead. Without this, an estimate that came back null before
// the very first real cell frame arrived (cellVoltages still all 0 at the
// moment START was pressed) would stay null forever, since nothing else
// would ever re-trigger the projection for a real device.
// Either way, only re-projects when the highest cell's distance above the
// Starting Voltage has moved by at least ESTIMATE_DIFF_STEP, so the time
// doesn't jump around for tiny changes.
function maybeReestimateOnIdle() {

    if (!balancingActive || !cellVoltages.length) return;

    if (simulationEnabled && !balancerResting()) return;

    const startVoltage = parseFloat(document.getElementById("eqLow").value);

    if (isNaN(startVoltage)) return;

    const diff = Math.max(...cellVoltages) - startVoltage;

    if (lastEstimateDiff === null || Math.abs(diff - lastEstimateDiff) >= ESTIMATE_DIFF_STEP) {
        resetBalanceEstimate();   // re-projects and refreshes lastEstimateDiff
    }

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

// Once the pack has actually reached balanced (highest and lowest cell within
// BALANCED_DIFF_V of each other), check whether it finished by the estimated
// COMPLETES AT time — and report ON TIME / early / late. Fires exactly once per
// balancing session. Works for real and simulated data alike, since it watches
// the live high−low difference, the same quantity the estimate is built from.
function checkBalanceCompletionVsEstimate() {

    if (!balancingActive || balanceCompletionChecked) return;

    if (cellVoltages.length < 2 || Math.max(...cellVoltages) <= 0) return;

    const difference = Math.max(...cellVoltages) - Math.min(...cellVoltages);

    // Not balanced yet — keep waiting.
    if (difference > BALANCED_DIFF_V) return;

    balanceCompletionChecked = true;

    const now = Date.now();

    const fmt = t => new Date(t).toLocaleTimeString([], {
        hour: "numeric", minute: "2-digit", second: "2-digit"
    });

    // Report actual-vs-estimated finish (only if an estimate was made).
    if (balanceDeadlineAt !== null) {

        // Positive = finished LATER than estimated; negative/zero = on time.
        const deltaSeconds = Math.round((now - balanceDeadlineAt) / 1000);

        const estStr = fmt(balanceDeadlineAt);
        const actStr = fmt(now);

        if (deltaSeconds <= 0) {

            const early = Math.abs(deltaSeconds);

            logEvent(
                `✅ Balancing Finished On Time — Estimated ${estStr}, Actual ${actStr}` +
                (early ? ` (${early}s early)` : " (exact)"),
                "success"
            );

        }

        else {

            logEvent(
                `⚠ Balancing Took Longer Than Estimated — Estimated ${estStr}, Actual ${actStr} (+${deltaSeconds}s)`,
                "error"
            );

        }

    }

    // Balancing is done — count it and AUTO-STOP the session, exactly like
    // pressing STOP, so the button returns to idle on its own.
    balancingCompletedCount++;
    saveBalanceStats();

    logEvent(`✅ Balancing Complete — Pack Balanced (${difference.toFixed(3)} V spread)`, "success");
    showStatus("✅ Balancing Complete — Auto-Stopped", "success");

    // Stop the whole session if START ran it; otherwise just stop balancing
    // (a Docklight-only $BALSTART with no BMS session).
    if (running) stopBMS();
    else stopBalancing();

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

    // During the duty-cycle rest balancingCellIndices() is empty on purpose —
    // that is a scheduled pause, not the balance finishing. Don't stop.
    if (balancerResting()) return;

    if (balancingCellIndices().length) return;

    // TEMP DIAGNOSTIC — one-shot, fires only at the actual completion
    // decision (not per-tick), so this is safe to leave in briefly. Remove
    // once the premature-completion issue is confirmed fixed.
    console.log("[finishBalancingIfSettled] declaring complete —", JSON.stringify({
        eqLow: parseFloat(document.getElementById("eqLow").value),
        cellVoltages: cellVoltages.slice(),
        passiveCellTimers,
        balancingMode
    }));

    balancingCompletedCount++;

    logEvent("✅ Balancing Complete — All Cells At Equilibrium Limit LOW", "success");
    showStatus("✅ Balancing Complete — Auto-Stopped", "success");

    // The whole-pack cycle limit was removed. Balancing is now bounded
    // only by the per-cell "balanced too many times" guard, not by a
    // count of full-pack cycles — so completing a cycle never locks out.
    saveBalanceStats();

    // Auto-stop BOTH the balancing AND the BMS session — pressing STOP for the
    // operator. stopBMS() stops the session and calls stopBalancing() itself;
    // if there was no BMS session (Docklight-only balance), just stop balancing.
    if (running) stopBMS();
    else stopBalancing();

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

    const startVoltage = parseFloat(document.getElementById("eqLow").value);

    const perTick = bleedPerTick();

    // No Equalizing Current configured — matches real hardware with the
    // balancer switched off — so no charge moves.
    if (isNaN(startVoltage) || perTick <= 0) return;

    const discharging = balancingCellIndices();

    if (!discharging.length) return;

    // Passive: every discharging cell (any number, from
    // advancePassiveCellTimers()) drains independently, floored at the
    // start voltage. No receiver, ever — the excess is dissipated through
    // a resistor, not moved.
    if (balancingMode === "passive") {

        discharging.forEach(i => {

            cellVoltages[i] = Math.max(startVoltage, cellVoltages[i] - perTick);

        });

        return;

    }

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
    //
    // A cell only ever GAINS charge as a receiver. A manually named receiver
    // (from Docklight) can already sit above the start voltage; the cap below
    // would otherwise drive it DOWN to the cap in one tick — a cell labelled
    // ▲ CHARGING moving the wrong way. So only apply the change when it
    // actually raises the receiver.
    const receiverTarget = Math.min(startVoltage, cellVoltages[receiver] + moved);

    if (receiverTarget > cellVoltages[receiver]) {

        cellVoltages[receiver] = receiverTarget;

    }

}

// ======================================
// RENDER CELL VALUES
// ======================================

// ---- Scale-to-fill: the dashboard is built at a fixed design width and
// zoomed to fill each screen's width, so the layout looks identical on any
// system (a laptop or a 4K), just scaled. Clamped so it never gets absurd. ----
function fitAppToScreen() {
    const design = 1700;
    const vw = document.documentElement.clientWidth || window.innerWidth || design;
    let z = vw / design;
    z = Math.min(Math.max(z, 0.72), 2);
    document.documentElement.style.setProperty("--zoom", z.toFixed(4));
}
window.addEventListener("resize", fitAppToScreen);
window.addEventListener("DOMContentLoaded", fitAppToScreen);
fitAppToScreen();

// Draw a moving energy-flow arrow from each DISCHARGING cell to the CHARGING
// (receiver) cell, over the pack — shows the transfer between the pair.
function renderPackFlow() {

    const svg = document.getElementById("packFlow");
    if (!svg) return;

    const receiver = cellCharging.findIndex(Boolean);
    const senders = [];
    for (let i = 0; i < CELL_COUNT; i++) if (cellBalancing[i]) senders.push(i);

    // Nothing transferring → clear the overlay.
    if (receiver < 0 || !senders.length) { svg.innerHTML = ""; return; }

    // The app is zoom-scaled, so getBoundingClientRect returns post-zoom pixels;
    // divide by the zoom to get the SVG's own (pre-zoom) user coordinates.
    const zoom = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--zoom")) || 1;
    const host = svg.parentElement.getBoundingClientRect();
    const rectOf = i => {
        const el = document.getElementById(`cellGauge${i + 1}`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
            cx: (r.left + r.width / 2 - host.left) / zoom,
            cy: (r.top + r.height / 2 - host.top) / zoom,
            top: (r.top - host.top) / zoom,
            bottom: (r.bottom - host.top) / zoom,
            w: r.width / zoom
        };
    };

    const c = rectOf(receiver);
    if (!c) { svg.innerHTML = ""; return; }

    let paths = "";
    senders.forEach(sIdx => {
        const s = rectOf(sIdx);
        if (!s || sIdx === receiver) return;
        const dx = Math.abs(c.cx - s.cx);
        let d;
        if (dx < s.w * 0.5) {
            // SAME COLUMN (one cell right above the other) → a straight vertical
            // arrow in the gap, pointing INTO the charging (receiver) cell.
            const x = ((s.cx + c.cx) / 2).toFixed(1);
            const above = c.cy < s.cy;                 // is the receiver above?
            const y1 = (above ? s.top - 4 : s.bottom + 4);   // start at the donor edge
            const y2 = (above ? c.bottom + 4 : c.top - 4);   // arrowhead at receiver edge
            d = `M ${x} ${y1.toFixed(1)} L ${x} ${y2.toFixed(1)}`;
        } else {
            // Different columns → arc over the cell tops.
            const p = { x: s.cx, y: s.top + 6 };
            const q = { x: c.cx, y: c.top + 6 };
            const mx = (p.x + q.x) / 2;
            const my = Math.min(p.y, q.y) - 30 - Math.abs(q.x - p.x) * 0.05;
            d = `M ${p.x.toFixed(1)} ${p.y.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
        }
        paths += `<path d="${d}" class="pf-flow-base"/>`;
        paths += `<path d="${d}" class="pf-flow-run" marker-end="url(#pfArrow)"/>`;
    });

    svg.innerHTML =
        `<defs><marker id="pfArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto">` +
        `<path d="M0,0 L10,5 L0,10 z" fill="#111827"/></marker></defs>` + paths;
}

function renderCells() {

    for (let i = 1; i <= CELL_COUNT; i++) {

        const voltage = cellVoltages[i - 1];

        // Just the number — the "V" unit is a separate line in the cylinder.
        document.getElementById(`cellVal${i}`).textContent = voltage.toFixed(3);

        // How many times this cell has been on each end of a transfer.
        const counts = document.getElementById(`cellCount${i}`);

        if (counts) {

            // Passive never charges a cell (bleed-only, no receiver — see
            // chargingCellIndex()), so cellChargeCount stays 0 for every
            // cell always. Showing "▲ 0" next to it would read as "this
            // could charge" when it never can — count only discharging.
            counts.innerHTML = balancingMode === "passive"
                ? `<span class="count-discharge">▼ ${cellDischargeCount[i - 1]}</span>`
                : `<span class="count-discharge">▼ ${cellDischargeCount[i - 1]}</span>` +
                  `<span class="count-charge">▲ ${cellChargeCount[i - 1]}</span>`;

        }

        // Battery fill level — how full the cell reads, mapped across the
        // 3.0V–4.0V range. The fill COLOUR carries the state: green while
        // charging, red while discharging, yellow otherwise.
        const pct = Math.min(100, Math.max(0, ((voltage - 3.0) / 1.0) * 100));

        const fill = document.getElementById(`cellFill${i}`);

        const idx = i - 1;

        // Colour the whole cell by its voltage LEVEL (very-high / high /
        // normal / low) — sets the --cc gradient + glow used by the fill.
        const lvl = cellLevel(i - 1);
        const card0 = document.getElementById(`cellCard${i}`);
        if (card0) {
            card0.classList.remove("lvl-normal", "lvl-high", "lvl-veryhigh", "lvl-low");
            card0.classList.add("lvl-" + lvl);
        }
        // Scale bar: voltage position on the 3.0–4.2 V range (0–100%).
        if (fill) {
            const scalePct = Math.max(2, Math.min(100, ((voltage - 3.0) / 1.2) * 100));
            fill.style.width = scalePct.toFixed(1) + "%";
        }

        // Status pill (icon + label), coloured by level via the card class.
        const st = document.getElementById(`cellStatus${i}`);
        if (st) {
            let txt;
            if (cellOVFault[idx]) txt = "↑ OVER VOLTAGE";
            else if (cellUVFault[idx]) txt = "↓ UNDER VOLTAGE";
            else if (lvl === "veryhigh") txt = "↑ VERY HIGH";
            else if (lvl === "high") txt = "↑ HIGH";
            else if (lvl === "low") txt = "↓ LOW";
            else txt = "✓ NORMAL";
            st.textContent = txt;
        }

        // Direction label under the cell — only for the active pair.
        const state = document.getElementById(`cellState${i}`);

        if (state) {

            if (cellCharging[idx]) {
                state.textContent = "▲ CHARGING";
                state.className = "cell-state chg";
            } else if (cellBalancing[idx]) {
                state.textContent = "▼ DISCHARGING";
                state.className = "cell-state dis";
            } else {
                state.textContent = "";
                state.className = "cell-state";
            }

        }

    }

    updateTopMetrics();

}

// Voltage-LEVEL bucket for the solid cylinder colour (reference-pack style):
//   veryhigh (red)  = the highest cell, or an over-voltage fault
//   low (blue)      = the lowest cell, or an under-voltage fault
//   high (yellow)   = clearly above the pack average (but not the max)
//   normal (green)  = everything else
function cellLevel(i) {

    const vals = cellVoltages;
    if (!vals.length) return "normal";

    if (cellOVFault[i]) return "veryhigh";
    if (cellUVFault[i]) return "low";

    const max = Math.max(...vals), min = Math.min(...vals);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;

    // "Very high" means genuinely standing out above the pack, not merely
    // tied for whatever the current max happens to be. Passive balancing
    // deliberately floors many cells to the SAME target voltage — once
    // several of them tie for the max, that's the balance succeeding, not
    // a danger, so it shouldn't paint the whole pack red. Falls through to
    // "high" below, same threshold that tier already uses.
    if (vals[i] >= max && vals[i] >= avg + 0.03) return "veryhigh";
    if (vals[i] <= min) return "low";
    if (vals[i] >= avg + 0.03) return "high";
    return "normal";
}

// Populate the top metric cards + summary cards (redesign) from REAL data:
// pack voltage = sum of cells, current from the setting, power/cycles mirror
// the values already computed for Battery Statistics, spread/avg/health derived.
function updateTopMetrics() {

    const vals = cellVoltages;
    if (!vals.length || Math.max(...vals) <= 0) return;

    const max = Math.max(...vals), min = Math.min(...vals);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sum = vals.reduce((a, b) => a + b, 0);
    const cur = parseFloat(document.getElementById("currentLimit")?.value) || 0;

    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    const mirror = (id, from) => { const f = document.getElementById(from); if (f) set(id, f.textContent); };

    set("packVoltage", sum.toFixed(2) + " V");
    set("packCurrent", cur.toFixed(2) + " A");
    mirror("packPower", "balancerPower");
    set("packSpread", (max - min).toFixed(3) + " V");
    mirror("packCycles", "balancingCycles");
    set("packCells", CELL_COUNT);
    set("packCellsHead", CELL_COUNT);
    renderCellStatePop();   // keep the popover counts live while it's open

    set("sumMax", "Cell " + (vals.indexOf(max) + 1) + " (" + max.toFixed(3) + " V)");
    set("sumMin", "Cell " + (vals.indexOf(min) + 1) + " (" + min.toFixed(3) + " V)");
    set("sumAvg", avg.toFixed(3) + " V");
    set("sumDiff", (max - min).toFixed(3) + " V");

    const h = (typeof packHealth === "function") ? packHealth() : { label: "-" };
    set("sumHealth", h.label);
}

// ======================================
// CELLS CARD → CHARGING / DISCHARGING POPOVER
// ======================================

// Fill the popover with the live charging / discharging cell counts + lists.
// No-op unless the popover is currently open.
function renderCellStatePop() {

    const pop = document.getElementById("cellStatePop");
    if (!pop || pop.style.display !== "block") return;

    // One row PER CELL: each cell's own charging and discharging count.
    // All reset to 0 on START (so 16 cells × 2 = 32 zeros), then each cell's
    // own count rises as that cell charges / discharges.
    // A count that reaches the Over-Balance Warning Limit is flagged red.
    const lim = overBalWarnLimit();

    // Passive never charges a cell (bleed-only, no receiver — see
    // chargingCellIndex()), so cellChargeTicks stays 0 for every cell
    // always — a whole "Charging" column of zeros would just be clutter.
    // Count only discharging.
    const passive = balancingMode === "passive";

    let rows = "";
    for (let i = 0; i < CELL_COUNT; i++) {
        const chgOver = cellChargeTicks[i] >= lim ? " csp-over" : "";
        const disOver = cellDischargeTicks[i] >= lim ? " csp-over" : "";
        rows +=
            `<tr>` +
                `<td class="csp-cn">Cell ${i + 1}</td>` +
                (passive ? "" : `<td class="csp-count csp-chg-v${chgOver}">${cellChargeTicks[i]}</td>`) +
                `<td class="csp-count csp-dis-v${disOver}">${cellDischargeTicks[i]}</td>` +
            `</tr>`;
    }

    // 3 columns (Cells | Charging | Discharging) in Active mode, 2 in Passive.
    pop.innerHTML =
        `<table class="csp-table">` +
            `<thead><tr>` +
                `<th>Cells</th>` +
                (passive ? "" : `<th class="csp-chg">Charging</th>`) +
                `<th class="csp-dis">Discharging</th>` +
            `</tr></thead>` +
            `<tbody>${rows}</tbody>` +
        `</table>`;
}

// Open / close the popover when the Cells card is clicked.
function toggleCellStatePopover(e) {

    if (e) e.stopPropagation();
    const pop = document.getElementById("cellStatePop");
    if (!pop) return;

    if (pop.style.display === "block") {
        pop.style.display = "none";
    } else {
        pop.style.display = "block";
        renderCellStatePop();
    }
}

// Click anywhere else closes the popover.
document.addEventListener("click", function () {
    const pop = document.getElementById("cellStatePop");
    if (pop) pop.style.display = "none";
});

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

    // The pack changed shape — a graph cell selection / highlight from the old
    // size no longer maps to anything, so clear them.
    if (selectedGraphCell !== null && selectedGraphCell >= CELL_COUNT) selectedGraphCell = null;
    graphHighlightGroup = null;

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

    // ALL levels are tracked now — the floating banner is gone, so the
    // Activity Log is where every alert lives: negative conditions logged
    // red, informational ones (e.g. Balancing Active) in the normal style.
    alerts.forEach(alert => current.set(alert.key, alert));

    current.forEach((alert, key) => {

        if (!activeAlerts.has(key)) {

            logEvent(alert.text, alert.level === "info" ? "info" : "error");

        }

    });

    activeAlerts.forEach((alert, key) => {

        if (current.has(key)) return;

        // Some conditions do not "resolve" — the cycle warning is replaced
        // by the cycle limit, which is worse, not better. Logging a green
        // "Cleared" line for those would read as good news.
        if (alert.noClearLog) return;

        // Informational alerts end with their own log line ("Balancing
        // Stopped") — an extra "Cleared" line would just be noise.
        if (alert.level === "info") return;

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
    const diffLimit = parseFloat(document.getElementById("diffLimit").value);
    const ovLimit = parseFloat(document.getElementById("ovProtection").value);
    const ovRecovery = parseFloat(document.getElementById("ovRecovery").value);
    const uvLimit = parseFloat(document.getElementById("uvProtection").value);
    const startVoltage = parseFloat(document.getElementById("eqLow").value);

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

        // Equilibrium Limit Voltage HIGH — absolute safe window (unchanged).
        // The LOW half of "Below Safe Limit" now comes from Single Under
        // Voltage Protection instead of Equilibrium LOW, since Equilibrium
        // LOW also doubles as the balancing threshold now — using it here
        // too would fire this warning for almost the whole pack any time
        // it's below a normal balancing target, not just genuinely low cells.
        if (!isNaN(eqHigh) && v > eqHigh) aboveLimit.push(i);
        if (!isNaN(uvLimit) && v < uvLimit) belowLimit.push(i);

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

        // "Balancing" here just means "currently in an ON burst" — it also
        // goes false for a cell that's merely entering its OFF rest pause
        // mid-session, not only when it truly finishes. Only call it
        // "Successful" once the cell has actually settled to the Starting
        // Voltage; otherwise it's just pausing, so say that instead.
        if (wasBalancing && !isBalancing) {

            const settled = !isNaN(startVoltage) && v <= startVoltage;

            if (settled) logEvent(`✅ Cell ${i + 1} Balancing Successful`, "success");
            else logEvent(`⏸ Cell ${i + 1} Balancing Paused — Resting`, "info");

        }

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

        // A balancing operation is a PAIR (one cell gives, one receives), so
        // each new transfer counts +1 for BOTH cells: the discharging cell's
        // discharge tally AND the receiving cell's charge tally rise together.
        // Counted once per new discharge start, not every tick.
        if (running && isBalancing && !wasBalancing) {
            cellDischargeTicks[i]++;
            if (receiver >= 0 && receiver !== i) cellChargeTicks[receiver]++;
        }

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

            // The balancing pair each names its partner so the transfer reads
            // as a set: the discharging cell shows where charge is going
            // (⚡ OUT ▸ CELL 6), the charging cell where it comes from
            // (⚡ IN ◂ CELL 3). Both badges flow-animate to show motion.
            if (isBalancing) {

                const to = receiver >= 0 ? ` ▸ CELL ${receiver + 1}` : "";
                texts.push({ text: `⚡ OUT ▼${to}`, cls: "discharging" });

            }

            if (isCharging) {

                const from = dischargingCells.length ? ` ◂ CELL ${dischargingCells[0] + 1}` : "";
                texts.push({ text: `⚡ IN ▲${from}`, cls: "charging" });

            }

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

    // Draw the energy-flow arrows from each discharging cell → the charging cell.
    renderPackFlow();

    logAlertChanges(alerts);

    // The floating alert pills are no longer drawn over the dashboard —
    // every alert goes to the Activity Log instead (logAlertChanges above):
    // negative conditions in red, informational ones in the normal style,
    // and a green "Cleared" line when a condition ends.
    banner.style.display = "none";

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

    // A cell has been balanced too many times — the over-balance protection is
    // active. Refuse to (re)start the pair here too, so a Docklight command or a
    // remote $BALSTART can't slip past the lockout. Cleared by pressing START on
    // the dashboard, which begins a fresh session.
    if (balancingLockedOut) {

        showStatus("⛔ Balancing Disabled — A Cell Was Balanced Too Many Times", "stop");
        logEvent("⛔ Balancing Refused — Over-Balance Lockout Active", "error");

        return;

    }

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

    // Active mode's hardware only ever connects a cell to an immediate
    // physical neighbor (confirmed from a real Docklight trace) — a
    // non-adjacent pair isn't something the board could actually be doing,
    // so it's refused rather than accepted at face value. The sender can
    // still dissipate on its own; only the invalid RECEIVER is dropped.
    if (balancingMode === "active" && receiver !== -1 && Math.abs(receiver - sender) !== 1) {

        showStatus(`⚠ Cell ${sender + 1} -> Cell ${receiver + 1} Refused — Not Adjacent`, "stop");
        logEvent(`⚠ Balancing Pair Refused — Cell ${sender + 1} And Cell ${receiver + 1} Are Not Neighbors`, "error");

        receiver = -1;

    }

    // Sticky receiver: the balancing command repeats every second on a busy
    // byte stream, and one repeat can arrive with its "-> CELLxx" cut off —
    // read as sender-only. That must NOT drop a receiver already set for the
    // same discharging cell (which would flip "Cell 3 -> Cell 6" back to "Cell
    // 3 dissipated"). Keep the known receiver. To genuinely switch to
    // dissipate, name a different pair or stop first.
    if (receiver === -1 && manualBalancePair &&
        manualBalancePair.sender === sender &&
        manualBalancePair.receiver !== -1) {

        receiver = manualBalancePair.receiver;

    }

    // Balancing was stopped by hand — do NOT restart from Docklight's
    // repeating command, but DO remember the pair it names: the operator may
    // change the selection (say 3→6 to 3→5) while stopped, and the next START
    // must resume the NEWEST pair, not the one from before the stop.
    if (manualBalanceBlocked) {

        lastManualPair = { sender, receiver };

        try { localStorage.setItem("bmsLastManualPair", JSON.stringify(lastManualPair)); }
        catch (e) { /* storage blocked — the in-memory copy still works */ }

        return;

    }

    // Re-sending the SAME pair (a Docklight loop repeats the command every
    // couple of seconds) must be a no-op — no repaint, no message. Only an
    // actual change is acted on, so nothing spams the screen.
    if (balancingActive && manualBalancePair &&
        manualBalancePair.sender === sender &&
        manualBalancePair.receiver === receiver) {

        return;

    }

    // A bare "$BALCELL" (no prior "$BALSTART") starts a fresh balancing
    // session on its own. When it does, zero the per-cell tallies exactly like
    // startBalancing — otherwise counts from the previous session carry over
    // and can trip the over-balance lockout early. If balancing was already
    // running (the normal BALSTART-then-BALCELL flow, or a mid-session pair
    // change) the counts are left alone.
    const startingFresh = !balancingActive;

    manualBalancePair = { sender, receiver };

    // Remember this selection so START can resume it later without Docklight
    // having to re-send the command — persisted so it survives a page reload.
    lastManualPair = { sender, receiver };

    try { localStorage.setItem("bmsLastManualPair", JSON.stringify(lastManualPair)); }
    catch (e) { /* storage blocked — the in-memory copy still works this session */ }

    balancingActive = true;

    if (startingFresh) {

        // Fresh Docklight-started session — begin the duty-cycle clock too.
        balancePhaseStartAt = Date.now();

        // Arm the actual-vs-estimated completion check for this new session.
        balanceCompletionChecked = false;

        // Snapshot the starting spread for the graph's progress bar.
        balanceStartSpread = (Math.max(...cellVoltages) > 0)
            ? Math.max(...cellVoltages) - Math.min(...cellVoltages)
            : null;

        balancingCycleCount++;

        cellDischargeCount = new Array(CELL_COUNT).fill(0);
        cellChargeCount = new Array(CELL_COUNT).fill(0);
        cellOverBalLastWarn = new Array(CELL_COUNT).fill(0);
        cellOverBalance = {};

        cellDischargedThisCycle = new Array(CELL_COUNT).fill(false);
        cellChargedThisCycle = new Array(CELL_COUNT).fill(false);

        saveBalanceStats();
        updateBalancingCycleStat();

    }

    const box = document.getElementById("balancingBox");
    if (box) box.style.display = "flex";

    // Show and project the completion time (COMPLETES AT) for this pair — the
    // Docklight-driven path and the START-resumes-pair path both come through
    // here, so the ETA has to be set up here too, not only in startBalancing().
    const etaBox = document.getElementById("etaBox");
    if (etaBox) etaBox.style.display = "block";

    resetBalanceEstimate();

    // Recompute cellBalancing / cellCharging from the new pair, then repaint
    // the balancing line, the cell badges, and Docklight.
    checkWarnings();
    updateBalancingDisplay();
    renderCells();

    // Push the new balancing status to Docklight at once (BAL : CELL03 -> CELL06),
    // not up to 2 s later on the next throttled tick.
    sendBalanceReport(true);

    // Resend a readable confirmation of the command back to Docklight, so the
    // operator sees the dashboard acted on the pair it sent. Only fires on an
    // actual pair change (repeats are deduped above), so it never spams.
    const cellName = index => "CELL" + String(index + 1).padStart(2, "0");

    sendActionLine(
        receiver === -1
            ? `BALANCING ${cellName(sender)} (REMOTE)`
            : `BALANCING ${cellName(sender)} -> ${cellName(receiver)} (REMOTE)`
    );

}

// Reflects balancingMode onto the BALANCER CONTROL heading and the
// dashboard's own Active/Passive toggle. Safe to call before the
// dashboard's DOMContentLoaded bootstrap runs — script.js loads at the
// end of <body>, so every element it touches already exists.
function syncBalancingModeUI() {

    const heading = document.getElementById("balancerModeHeading");
    if (heading) heading.textContent = balancingMode === "passive" ? "PASSIVE BALANCING" : "ACTIVE BALANCING";

    const activeBtn = document.getElementById("dashModeActiveBtn");
    const passiveBtn = document.getElementById("dashModePassiveBtn");

    if (activeBtn) activeBtn.classList.toggle("selected", balancingMode === "active");
    if (passiveBtn) passiveBtn.classList.toggle("selected", balancingMode === "passive");

}

syncBalancingModeUI();

// Switches between Active (cell-to-cell transfer, one pair at a time) and
// Passive (resistor bleed, no receiver, any number of cells at once — see
// advancePassiveCellTimers()). Refused while balancing is running so the
// algorithm never changes mid-transfer — same "refuse with a clear
// reason" pattern as the over-balance lockout below.
function setBalancingMode(mode) {

    if (mode !== "active" && mode !== "passive") return;

    if (mode === balancingMode) return;

    if (balancingActive) {

        showStatus("⛔ Stop Balancing Before Switching Mode", "stop");
        logEvent("⛔ Balancing Mode Switch Refused — Balancing Is Active", "error");

        return;

    }

    balancingMode = mode;

    try { localStorage.setItem("bmsBalancingMode", mode); }
    catch (e) { /* storage blocked — the in-memory choice still works this session */ }

    syncBalancingModeUI();

    const label = mode === "passive" ? "Passive" : "Active";

    showStatus(`⚖ Switched To ${label} Balancing`, "success");
    logEvent(`⚖ Balancing Mode Set To ${label}`, "info");

}

async function startBalancing(transmit = true) {

    // START is the deliberate "go": lift the post-STOP block so Docklight's
    // balancing command is honoured again.
    manualBalanceBlocked = false;

    // In SIMULATION the dashboard picks the pair itself (highest→lowest), so a
    // dashboard START clears any pinned pair and starts fresh. On a REAL
    // device the pair belongs to Docklight — pressing START must balance
    // EXACTLY the cells Docklight selected (e.g. Cell 3 -> Cell 6), so the
    // Docklight pair is kept, not wiped.
    if (simulationEnabled) {

        manualBalancePair = null;

    }

    // Real device: if no pair is currently pinned but Docklight named one
    // earlier, re-apply it so START resumes that exact balance automatically —
    // the operator doesn't have to re-send "BAL : CELL03 -> CELL06". It is
    // applied through setManualBalancePair(), EXACTLY like a live Docklight
    // command: it activates and displays the pair and skips the simulation-only
    // guards below (already-balanced / auto-pick) that would otherwise refuse
    // to show a perfectly valid Docklight selection. (Current-zero and
    // under-voltage are already enforced by startBMS before START ever runs.)
    else if (!manualBalancePair && lastManualPair) {

        if (transmit) await sendSerialCommand("BALSTART");

        setManualBalancePair(lastManualPair.sender, lastManualPair.receiver);

        return;

    }


    // Already balancing (e.g. a Docklight pair is live) — still signal
    // "$BALSTART#" to Docklight so pressing START always tells the device to
    // start balancing, then stop (nothing else to set up).
    if (balancingActive) {

        if (transmit) await sendSerialCommand("BALSTART");

        return;

    }

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

    // Start the duty-cycle clock now: the first ON block begins here, with the
    // first rest coming after BALANCE_ON seconds.
    balancePhaseStartAt = Date.now();

    // Arm the actual-vs-estimated completion check for this new session.
    balanceCompletionChecked = false;

    // Snapshot the starting spread for the graph's progress bar.
    balanceStartSpread = (Math.max(...cellVoltages) > 0)
        ? Math.max(...cellVoltages) - Math.min(...cellVoltages)
        : null;

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

    // Start each cell's per-cell graph fresh from this moment, so the chart
    // spans the whole session — from balancing START right through to the end.
    graphHistory = [];

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

    // Latch balancing OFF: Docklight keeps re-sending its balancing command
    // every second, and without this the very next one would restart the
    // balance the operator just stopped. Cleared only by an explicit START /
    // $BALSTART.
    manualBalanceBlocked = true;

    // Any Docklight-pinned pair ends with the balance — the next start picks
    // fresh, whether it comes from Docklight or the dashboard.
    manualBalancePair = null;
    manualPassiveCells = null;

    balanceDeadlineAt = null;

    // Duty-cycle clock ends with the session.
    balancePhaseStartAt = null;
    balanceStartSpread = null;
    passiveCellTimers = {};

    // The per-cell charge/discharge counts are left as they stand at STOP
    // (frozen, not cleared) so the final tally stays on screen — the next
    // START zeroes them again. Only the per-cycle participation flags clear
    // here, so the next cycle can count each cell again.
    cellDischargedThisCycle = new Array(CELL_COUNT).fill(false);
    cellChargedThisCycle = new Array(CELL_COUNT).fill(false);

    saveBalanceStats();

    // Recompute the cell states NOW (balancingActive is already false, so this
    // clears every .balancing / .charging class, the ⚡/🔋 symbols and the
    // amber/teal fills) instead of leaving them on screen until the next tick.
    checkWarnings();

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

    // Flip the indicator back to red "BALANCING IDLE" at once.
    updateBalancingStatus();

    // Tell Docklight it's idle now (BAL : IDLE), immediately.
    sendBalanceReport(true);

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
// The indicator button above START — RED "BALANCING IDLE" when nothing is
// balancing, GREEN with the active pair when it is. Reads cellBalancing[] and
// chargingCellIndex(), so it works the same in Automatic and Real Device mode.
function updateBalancingStatus() {

    const pill = document.getElementById("balancingStatus");
    const text = document.getElementById("balancingStatusText");

    if (!pill || !text) return;

    const discharging = cellBalancing
        .map((isBalancing, index) => (isBalancing ? index : -1))
        .filter(index => index !== -1);

    // Two-line badge: "Balancing" on top, Active / Resting / Idle below.
    text.textContent = "Balancing";

    const active = balancingActive && discharging.length > 0;

    const sub = document.getElementById("balancingStatusSub");
    if (sub) sub.textContent = active ? "Active" : (balancingActive ? "Resting" : "Idle");

    pill.classList.toggle("active", active);
    pill.classList.toggle("idle", !active);

}

function updateBalancingDisplay() {

    // The indicator shows both states, so refresh it BEFORE the early return —
    // this function runs every tick.
    updateBalancingStatus();

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

    const startVoltage = parseFloat(document.getElementById("eqLow").value);

    const discharging = cellBalancing
        .map((isBalancing, index) => (isBalancing ? index : -1))
        .filter(index => index !== -1);

    if (!discharging.length) {

        title.innerHTML = "⚖ BALANCING";

        list.innerHTML = "";

        // Passive: no single session-wide rest clock — each cell times
        // itself independently, so show a countdown to whichever resting
        // cell resumes soonest (there may be any number of them).
        if (balancingMode === "passive") {

            const restingCells = Object.values(passiveCellTimers).filter(t => t.phase === "off");

            if (restingCells.length) {

                const soonest = Math.min(...restingCells.map(t =>
                    Math.max(1, Math.ceil(t.phaseDurationS - (Date.now() - t.phaseStartAt) / 1000))
                ));

                note.innerHTML = `⏸ Resting — resumes in ${soonest}s`;

                return;

            }

            // Real Passive hardware reports its own cells via "BAL CELLS : ..."
            // (see detectPassiveBalCellsReport()) — NOT $BALCELL, which is
            // Active's single-pair command and doesn't apply here.
            if (!simulationEnabled) {

                note.innerHTML = manualPassiveCells === null
                    ? "Waiting for the board's BAL CELLS report"
                    : "Board reports no cell currently balancing";

                return;

            }

            note.innerHTML = isNaN(startVoltage)
                ? "Set Equilibrium Limit Voltage LOW"
                : bleedPerTick() <= 0
                    ? "Set an Equalizing Current"
                    : `No cell above ${startVoltage.toFixed(3)} V`;

            return;

        }

        // Duty-cycle rest — a scheduled pause, not a stop. Say so, with a
        // countdown to the next ON block, so it never looks like it quit.
        if (balancerResting()) {

            const onS = balanceOnSeconds();
            const offS = balanceOffSeconds();
            const position = ((Date.now() - balancePhaseStartAt) / 1000) % (onS + offS);
            const restLeft = Math.max(1, Math.ceil((onS + offS) - position));

            note.innerHTML = `⏸ Resting — resumes in ${restLeft}s`;

            return;

        }

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
            ? "Set Equilibrium Limit Voltage LOW"
            : bleedPerTick() <= 0
                ? "Set an Equalizing Current"
                : `No cell above ${startVoltage.toFixed(3)} V`;

        return;

    }

    // Passive: list every currently-bleeding cell (no cap) — never a
    // receiver, since Passive never has one.
    if (balancingMode === "passive") {

        // The sequential Stage 1 -> Stage 2 gate in advancePassiveCellTimers()
        // means every cell currently discharging is always the SAME stage at
        // once — so the stage is shown once, in the heading, rather than
        // repeated on every cell's row. Colour-coded (Stage 1 warm/red,
        // Stage 2 cool/teal) so the two read apart at a glance.
        const stage = (discharging.length && !isNaN(startVoltage))
            ? passiveStageForVoltage(cellVoltages[discharging[0]], startVoltage)
            : null;

        const stageTag = stage === null
            ? ""
            : ` <span class="bal-stage bal-stage-${stage}">· STAGE ${stage} (${stage === 1 ? "40s" : "10s"})</span>`;

        title.innerHTML = `⚖ ACTIVE CHANNELS: ${discharging.length}${stageTag}`;

        list.innerHTML = discharging
            .map(i => `<span class="bal-dis">▼ Cell ${i + 1} ${cellVoltages[i].toFixed(3)} V</span>`)
            .join(" ");

        const passiveClock = balanceCompletionClock();

        note.innerHTML = passiveClock === null
            ? "Set an Equalizing Current to estimate"
            : `Completes at ${passiveClock} (from current & cell difference)`;

        const passiveEta = document.getElementById("balanceEta");

        if (passiveEta) passiveEta.innerHTML = passiveClock === null ? "--" : passiveClock;

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

    // The completion time is FIXED: it is projected ONCE when balancing starts
    // and never re-calculated, so COMPLETES AT stays put for the whole balance
    // instead of drifting. (No re-projection here on purpose.)
    const clock = balanceCompletionClock();

    // Show the clock time it should finish, not a countdown. No rate means
    // no honest estimate — say so rather than print a time that never
    // arrives. Where a time IS shown, name its source: a measured rate is
    // fact, a configured one is a guess.
    note.innerHTML = clock === null
        ? "Set an Equalizing Current to estimate"
        : `Completes at ${clock} (from current & cell difference)`;

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

// ======================================
// CELL VOLTAGE GRAPH
// A bar chart of every cell's live voltage, opened from the GRAPH button.
// Bars are coloured by STATE (highest / lowest / discharging / charging /
// normal) — matching the dashboard — rather than a per-cell rainbow, so the
// interesting cells read at a glance. Redrawn live while the modal is open.
// ======================================

let graphOpen = true;             // graph is embedded inline on the dashboard now
let selectedGraphCell = null;     // cell index clicked for detail, or null
let graphHighlightGroup = null;   // a state group to highlight, or null
let graphView = "voltage";        // "voltage" | "deviation" | "sorted" | "trend"
let graphChart = null;            // analysis chart: convergence|spread|gantt|energy|histogram|deviation

// Rolling history of pack max / avg / min (with timestamps) for the Trend view,
// sampled every live tick regardless of whether the graph is open, so the trend
// already has data the moment it is opened.
let graphHistory = [];
// High cap so a full balancing session fits start→end (≈ 1 hour at a 1.5 s
// tick). The oldest points still drop past this, but a normal session is well
// within it, so each cell's chart shows the whole run.
const GRAPH_HISTORY_MAX = 2400;

function recordGraphHistory() {

    if (!cellVoltages.length) return;

    const maxV = Math.max(...cellVoltages);
    if (maxV <= 0) return;

    const now = Date.now();

    const minV = Math.min(...cellVoltages);
    const avg = cellVoltages.reduce((a, b) => a + b, 0) / cellVoltages.length;

    // Store EVERY cell's voltage AND its state (0 idle, 1 discharging,
    // 2 charging) at this instant, so any single cell's trend can be split
    // into "idle" vs "balancing" voltage later.
    const states = cellVoltages.map((_, i) =>
        cellCharging[i] ? 2 : cellBalancing[i] ? 1 : 0);

    graphHistory.push({ t: now, cells: cellVoltages.slice(), states, max: maxV, avg, min: minV });

    if (graphHistory.length > GRAPH_HISTORY_MAX) graphHistory.shift();

}

// A one-line health verdict for the pack, shown as a badge in the graph header.
function packHealth() {

    if (!cellVoltages.length || Math.max(...cellVoltages) <= 0) {
        return { label: "No Data", cls: "gh-none" };
    }

    if (balancingActive) return { label: "Balancing", cls: "gh-bal" };

    const spread = Math.max(...cellVoltages) - Math.min(...cellVoltages);
    const diffLimit = parseFloat(document.getElementById("diffLimit")?.value);

    if (spread <= BALANCED_DIFF_V) return { label: "Balanced", cls: "gh-good" };
    if (!isNaN(diffLimit) && spread > diffLimit) return { label: "Imbalanced", cls: "gh-bad" };

    return { label: "In Range", cls: "gh-ok" };

}

// Only charging (green) and discharging (red) get a distinct colour; every
// other cell — normal, highest, lowest alike — is yellow, matching the
// battery-shaped cells on the dashboard.
// Match the battery cells: normal = yellow, discharging = red, charging = green.
const GRAPH_GROUP_COLOR = { normal: "#f5c518", dis: "#ef4444", chg: "#22c55e" };
const GRAPH_GROUP_NAME  = { normal: "Normal",  dis: "Discharging", chg: "Charging" };

// Set true just before a render that should play entrance animations (grow
// bars / draw the line). Consumed — reset to false — at the end of renderGraph,
// so the per-tick live refreshes don't re-trigger the intro every 1.5 s.
let graphAnimate = false;

// The graph is embedded inline on the dashboard; "open" just scrolls to it.
function openGraph() {

    graphOpen = true;
    graphAnimate = true;
    renderGraph();

    const card = document.getElementById("graphInlineCard");
    if (card && card.scrollIntoView) card.scrollIntoView({ behavior: "smooth", block: "center" });

}

// Kept for callers (logout/restart) — the inline graph stays rendered.
function closeGraph() { /* inline graph — nothing to close */ }

// Click a bar → toggle its detail panel.
function selectGraphCell(i) {

    selectedGraphCell = (selectedGraphCell === i) ? null : i;
    graphAnimate = true;
    renderGraph();

}

// Step to the previous / next cell in the single-cell view (wraps around).
function stepGraphCell(delta) {

    if (selectedGraphCell === null) return;
    selectedGraphCell = (selectedGraphCell + delta + CELL_COUNT) % CELL_COUNT;
    graphChart = null;
    graphHighlightGroup = null;
    graphAnimate = true;
    renderGraph();

}

// Jump straight to a cell from the chip strip.
function jumpGraphCell(i) {

    selectedGraphCell = i;
    graphChart = null;
    graphHighlightGroup = null;
    graphAnimate = true;
    renderGraph();

}

// Build the ◀ ▶ + C1…Cn chip strip; only visible in the single-cell view.
function renderGraphCellNav() {

    const nav = document.getElementById("graphCellNav");
    if (!nav) return;

    if (selectedGraphCell === null) {
        nav.style.display = "none";
        nav.innerHTML = "";
        return;
    }

    let chips = "";
    for (let i = 0; i < CELL_COUNT; i++) {
        chips += `<button type="button" class="gnav-chip${i === selectedGraphCell ? " active" : ""}" onclick="jumpGraphCell(${i})">${i + 1}</button>`;
    }

    nav.style.display = "flex";
    nav.innerHTML =
        `<button type="button" class="gnav-arrow" onclick="stepGraphCell(-1)" title="Previous cell">◀</button>` +
        `<div class="gnav-chips">${chips}</div>` +
        `<button type="button" class="gnav-arrow" onclick="stepGraphCell(1)" title="Next cell">▶</button>`;

}

// Build the "Show" dropdown: All cells, then group filters (charging /
// discharging / normal / warning / critical), then every individual cell.
// Rebuilt only when the cell count changes.
function populateCellSelect() {

    const sel = document.getElementById("graphCellSelect");
    if (!sel) return;

    if (sel.dataset.count === String(CELL_COUNT)) return;
    sel.dataset.count = String(CELL_COUNT);

    let html = `<option value="all">All cells (bars)</option>`;

    html += `<optgroup label="Analysis charts">`;
    html += `<option value="chart:multiples">🔲 All cells — separate mini-charts</option>`;
    html += `<option value="chart:convergence">📉 Convergence band (Max/Avg/Min)</option>`;
    html += `<option value="chart:spread">📈 Spread closing (mV → target)</option>`;
    html += `<option value="chart:gantt">📊 Balancing timeline (per cell)</option>`;
    html += `<option value="chart:energy">⚡ Energy moved (donor vs receiver)</option>`;
    html += `<option value="chart:deviation">🎯 Deviation bars (from average)</option>`;
    html += `<option value="chart:histogram">📶 Voltage distribution</option>`;
    html += `</optgroup>`;

    html += `<optgroup label="Cell groups">`;
    html += `<option value="g:chg">⚡ Charging cells</option>`;
    html += `<option value="g:dis">🔻 Discharging cells</option>`;
    html += `<option value="g:normal">🟡 Normal cells</option>`;
    html += `<option value="g:warning">⚠ Warning cells</option>`;
    html += `<option value="g:critical">⛔ Critical cells</option>`;
    html += `</optgroup>`;

    html += `<optgroup label="Individual cells">`;
    for (let i = 0; i < CELL_COUNT; i++) html += `<option value="c:${i}">Cell ${i + 1}</option>`;
    html += `</optgroup>`;

    sel.innerHTML = html;

}

// Dropdown changed → either focus one cell (c:N), filter a group (g:key),
// or clear back to all cells.
function onCellSelectChange(val) {

    if (val && val.indexOf("c:") === 0) {
        selectedGraphCell = parseInt(val.slice(2), 10);
        graphHighlightGroup = null;
        graphChart = null;
    } else if (val && val.indexOf("g:") === 0) {
        graphHighlightGroup = val.slice(2);
        selectedGraphCell = null;
        graphChart = null;
    } else if (val && val.indexOf("chart:") === 0) {
        graphChart = val.slice(6);
        selectedGraphCell = null;
        graphHighlightGroup = null;
    } else {
        selectedGraphCell = null;
        graphHighlightGroup = null;
        graphChart = null;
    }

    graphAnimate = true;
    renderGraph();

}

// The value the "Show" dropdown should display for the current selection.
function currentShowValue() {

    if (graphChart) return "chart:" + graphChart;
    if (selectedGraphCell !== null) return "c:" + selectedGraphCell;
    if (graphHighlightGroup) return "g:" + graphHighlightGroup;
    return "all";

}

// Programmatic group filter (still used elsewhere) → highlight one group.
function toggleGraphGroup(group) {

    graphHighlightGroup = (graphHighlightGroup === group) ? null : group;
    selectedGraphCell = null;
    renderGraph();

}

// Switch the chart view: absolute Voltage, Deviation-from-average, or Sorted.
function setGraphView(v) {

    graphView = v;

    document.querySelectorAll(".gview-btn").forEach(b =>
        b.classList.toggle("active", b.dataset.view === v));

    renderGraph();

}

// Collect every graph CSS rule (.g-*) from the page stylesheets, so it can be
// embedded into the exported SVG — otherwise the PNG loses all class-based
// colours and label styling (the SVG-as-image can't see the external CSS).
function collectGraphCss() {

    let css = "";
    const add = rules => {
        for (const rule of rules) {
            if (rule.selectorText && /\.g-|graph-svg/.test(rule.selectorText)) css += rule.cssText + "\n";
            else if (rule.cssRules && rule.media) add(rule.cssRules); // inside @media
        }
    };
    for (const sheet of document.styleSheets) {
        try { if (sheet.cssRules) add(sheet.cssRules); } catch (e) { /* cross-origin */ }
    }
    return css;
}

// Save the current chart as a PNG image (2× for crispness), styled exactly as
// on screen (colours + values embedded).
function exportGraphPNG() {

    const svg = document.querySelector("#graphBody svg");
    if (!svg) return;

    // Clone and embed the CSS + a dark background so the PNG matches the screen.
    const clone = svg.cloneNode(true);
    const styleEl = document.createElementNS("http://www.w3.org/2000/svg", "style");
    styleEl.textContent = collectGraphCss();
    clone.insertBefore(styleEl, clone.firstChild);
    const bgRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bgRect.setAttribute("x", "0"); bgRect.setAttribute("y", "0");
    bgRect.setAttribute("width", "100%"); bgRect.setAttribute("height", "100%");
    bgRect.setAttribute("fill", "#ffffff");
    clone.insertBefore(bgRect, styleEl.nextSibling);

    const xml = new XMLSerializer().serializeToString(clone);
    const src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(xml)));

    const img = new Image();

    img.onload = () => {

        const scale = 2;
        const vb = svg.viewBox.baseVal;
        const canvas = document.createElement("canvas");

        canvas.width = (vb && vb.width ? vb.width : 820) * scale;
        canvas.height = (vb && vb.height ? vb.height : 420) * scale;

        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        canvas.toBlob(blob => {

            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");

            const pack = getPackNo();
            a.href = url;
            a.download = `CellGraph${pack ? "_Pack" + pack : ""}_${todayDateStr()}_${csvTimeStr().replace(/:/g, "-")}.png`;

            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);

            URL.revokeObjectURL(url);

        });

    };

    img.src = src;

}

// Which colour bucket a cell falls in: only charging / discharging differ,
// everything else (incl. highest/lowest) is "normal" (yellow).
function graphCellGroup(i) {

    if (cellBalancing[i]) return "dis";
    if (cellCharging[i]) return "chg";
    return "normal";

}

// Health bucket for a cell:
//   critical → over/under-voltage fault (out of safe range)
//   warning  → no fault, but out of balance (far from the pack average)
//   normal   → in range and close to the average
function graphCellSeverity(i) {

    if (cellOVFault[i] || cellUVFault[i]) return "critical";

    const vals = cellVoltages;
    if (!vals.length) return "normal";

    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;

    // >30 mV away from the average = noticeably out of balance.
    return Math.abs(vals[i] - avg) > 0.03 ? "warning" : "normal";

}

// Whether a cell should be dimmed given the active "Show" filter. Charging /
// discharging match the live state; normal / warning / critical match the
// health bucket above.
function graphIsDimmed(i) {

    const f = graphHighlightGroup;
    if (!f) return false;

    if (f === "chg") return !cellCharging[i];
    if (f === "dis") return !cellBalancing[i];

    if (f === "critical") return graphCellSeverity(i) !== "critical";
    if (f === "warning") return graphCellSeverity(i) !== "warning";
    if (f === "normal") return graphCellSeverity(i) !== "normal";

    // Back-compat with any older keys.
    if (f === "ov") return !cellOVFault[i];
    if (f === "uv") return !cellUVFault[i];

    return false;

}

// Blend a hex colour toward white — used for the top of each bar's gradient.
function graphLighten(hex, amt) {

    const nn = parseInt(hex.slice(1), 16);

    let r = (nn >> 16) & 255, g = (nn >> 8) & 255, b = nn & 255;

    r = Math.round(r + (255 - r) * amt);
    g = Math.round(g + (255 - g) * amt);
    b = Math.round(b + (255 - b) * amt);

    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);

}

// SVG path for a bar rounded on the TOP corners only (flat on the baseline) —
// the professional bar-chart look, instead of a fully-rounded rect.
function graphTopRect(x, y, w, h, r) {

    r = Math.max(0, Math.min(r, w / 2, h));

    const x2 = x + w, yb = y + h;

    return `M ${x.toFixed(1)} ${yb.toFixed(1)} ` +
           `L ${x.toFixed(1)} ${(y + r).toFixed(1)} ` +
           `Q ${x.toFixed(1)} ${y.toFixed(1)} ${(x + r).toFixed(1)} ${y.toFixed(1)} ` +
           `L ${(x2 - r).toFixed(1)} ${y.toFixed(1)} ` +
           `Q ${x2.toFixed(1)} ${y.toFixed(1)} ${x2.toFixed(1)} ${(y + r).toFixed(1)} ` +
           `L ${x2.toFixed(1)} ${yb.toFixed(1)} Z`;

}

// Catmull-Rom → cubic-bézier smoothing. Takes [[x,y],…] and returns an SVG
// path `d` that glides through every point instead of the hard kinks a
// <polyline> makes. Tension ~0.2 keeps it gentle (no overshoot loops).
function smoothD(points, tension) {
    if (!points || !points.length) return "";
    if (points.length < 3)
        return "M " + points.map(p => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" L ");

    const t = (tension == null) ? 0.2 : tension;
    let d = `M ${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`;

    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[i - 1] || points[i];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[i + 2] || p2;
        const c1x = p1[0] + (p2[0] - p0[0]) * t;
        const c1y = p1[1] + (p2[1] - p0[1]) * t;
        const c2x = p2[0] - (p3[0] - p1[0]) * t;
        const c2y = p2[1] - (p3[1] - p1[1]) * t;
        d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
    }
    return d;
}

// Smooth filled area: the smooth top edge, then closed down to a baseline.
function smoothArea(points, baseY) {
    if (!points || points.length < 2) return "";
    return `${smoothD(points)} L ${points[points.length - 1][0].toFixed(1)} ${baseY.toFixed(1)}` +
           ` L ${points[0][0].toFixed(1)} ${baseY.toFixed(1)} Z`;
}

// Returns a function that draws a thin dashed reference line at a voltage — NO
// in-chart label (the limit VALUES are shown in the panel below the chart).
function graphRefLine(lo, hi, yOf, padL, padR, W) {
    return (val, col) => {
        if (isNaN(val) || val < lo || val > hi) return "";
        const y = yOf(val);
        return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="${col}" stroke-width="1.4" stroke-dasharray="6 4" opacity="0.65"/>`;
    };
}

// Crosshair state for the single-cell comparison chart (set during render).
let graphCrosshairData = null;

// Move the pointer over the single-cell chart → a vertical crosshair snaps to
// the nearest reading and a tooltip shows the time + idle/balancing voltages.
function graphCrosshair(evt) {

    const svg = document.querySelector("#graphBody svg");
    const g = document.getElementById("graphCrosshairG");
    if (!svg || !g || !graphCrosshairData) return;

    const ctm = svg.getScreenCTM();
    if (!ctm) return;

    const d = graphCrosshairData;
    const pt = svg.createSVGPoint();
    pt.x = (evt.touches && evt.touches[0]) ? evt.touches[0].clientX : evt.clientX;
    pt.y = (evt.touches && evt.touches[0]) ? evt.touches[0].clientY : evt.clientY;

    const loc = pt.matrixTransform(ctm.inverse());
    const cx = Math.max(d.padL, Math.min(d.padL + d.plotW, loc.x));

    const nearest = arr => {
        if (!arr || !arr.length) return null;
        let best = arr[0], bd = Math.abs(arr[0].x - cx);
        for (const p of arr) { const dd = Math.abs(p.x - cx); if (dd < bd) { bd = dd; best = p; } }
        return best;
    };

    const ip = nearest(d.idle), bp = nearest(d.bal);
    const ref = (ip && bp) ? (Math.abs(ip.x - cx) <= Math.abs(bp.x - cx) ? ip : bp) : (ip || bp);
    if (!ref) return;

    const snapX = ref.x;
    const secsAgo = Math.round((d.t0 + d.span - ref.t) / 1000);
    const timeLabel = secsAgo <= 0 ? "now" : "-" + secsAgo + "s";

    let html = `<line x1="${snapX.toFixed(1)}" y1="${d.padT}" x2="${snapX.toFixed(1)}" y2="${d.baseline}" stroke="#8896ac" stroke-width="1" stroke-dasharray="4 4"/>`;

    if (ip) html += `<circle cx="${ip.x.toFixed(1)}" cy="${ip.y.toFixed(1)}" r="4.5" fill="${d.idleCol}" stroke="#ffffff" stroke-width="1.5"/>`;
    if (bp) html += `<circle cx="${bp.x.toFixed(1)}" cy="${bp.y.toFixed(1)}" r="4.5" fill="${d.balCol}" stroke="#ffffff" stroke-width="1.5"/>`;

    const parts = [timeLabel];
    if (ip) parts.push(`idle ${ip.v.toFixed(3)}V`);
    if (bp) parts.push(`bal ${bp.v.toFixed(3)}V`);
    const label = parts.join("   ");
    const boxW = Math.max(96, label.length * 6.6);
    let bx = snapX - boxW / 2;
    bx = Math.max(d.padL, Math.min(d.padL + d.plotW - boxW, bx));

    html += `<rect x="${bx.toFixed(1)}" y="${(d.padT - 4).toFixed(1)}" width="${boxW.toFixed(1)}" height="22" rx="6" fill="#ffffff" stroke="#cbd5e1" stroke-width="1"/>`;
    html += `<text x="${(bx + boxW / 2).toFixed(1)}" y="${(d.padT + 11).toFixed(1)}" text-anchor="middle" style="fill:#111827;font-size:11px;font-weight:700">${label}</text>`;

    g.innerHTML = html;
}

function graphCrosshairClear() {
    const g = document.getElementById("graphCrosshairG");
    if (g) g.innerHTML = "";
}

// Tap or hover a graph point → show its voltage in a small floating pill.
// pointerdown covers both mouse and touch; the pill fades after a moment.
let graphTipTimer = null;
function graphPointTip(evt, text) {

    if (evt && evt.stopPropagation) evt.stopPropagation();

    let tip = document.getElementById("graphPointTip");
    if (!tip) {
        tip = document.createElement("div");
        tip.id = "graphPointTip";
        tip.className = "graph-point-tip";
        document.body.appendChild(tip);
    }

    const px = evt.touches && evt.touches[0] ? evt.touches[0].clientX : evt.clientX;
    const py = evt.touches && evt.touches[0] ? evt.touches[0].clientY : evt.clientY;

    tip.textContent = text;
    tip.style.left = px + "px";
    tip.style.top = (py - 38) + "px";
    tip.classList.add("show");

    clearTimeout(graphTipTimer);
    graphTipTimer = setTimeout(() => tip.classList.remove("show"), 2500);
}

// ======================================================================
// ANALYSIS CHARTS — the six session-analysis plots picked from the Show
// dropdown. Each returns an SVG-inner string for the given chart frame F.
// ======================================================================
function renderAnalysisChart(type, F) {

    const { W, H, padL, padR, padT, plotW, plotH, baseline, n } = F;
    const collecting = `<text x="${W / 2}" y="${H / 2}" class="g-axistitle" text-anchor="middle">Collecting data… keep the graph open for a few seconds</text>`;

    // Shared helpers -----------------------------------------------------
    const yAxis = (ylo, yhi, ty, dec, unit) => {
        let s = "";
        for (let k = 0; k <= 5; k++) {
            const v = ylo + (yhi - ylo) * (k / 5);
            const y = ty(v);
            s += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" class="g-grid"/>`;
            s += `<text x="${(padL - 8).toFixed(1)}" y="${(y + 4).toFixed(1)}" class="g-ylabel">${v.toFixed(dec)}${unit || ""}</text>`;
        }
        return s;
    };
    const xTime = (t0, span, tx) => {
        let s = "";
        for (let k = 0; k <= 4; k++) {
            const tt = t0 + span * (k / 4);
            const secsAgo = Math.round((t0 + span - tt) / 1000);
            s += `<text x="${tx(tt).toFixed(1)}" y="${(baseline + 18).toFixed(1)}" class="g-xlabel">${secsAgo === 0 ? "now" : "-" + secsAgo + "s"}</text>`;
        }
        return s;
    };
    const axis = `<line x1="${padL}" y1="${baseline}" x2="${W - padR}" y2="${baseline}" class="g-axis"/>`;
    const yTitle = txt => `<text x="16" y="${(padT + plotH / 2).toFixed(1)}" class="g-axistitle" transform="rotate(-90 16 ${(padT + plotH / 2).toFixed(1)})">${txt}</text>`;
    const xTitle = txt => `<text x="${(padL + plotW / 2).toFixed(1)}" y="${H - 8}" class="g-axistitle">${txt}</text>`;
    const line = (pts, col, dash) => `<path d="${smoothD(pts)}" fill="none" stroke="${col}" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ""} style="filter:drop-shadow(0 0 4px ${col}88)"/>`;

    // ---- Time-series charts share this history setup ----
    const hist = graphHistory.slice();

    // =================================================================
    if (type === "convergence") {

        if (hist.length < 2) return collecting;
        const t0 = hist[0].t, t1 = hist[hist.length - 1].t, span = Math.max(1, t1 - t0);
        let ylo = Math.min(...hist.map(p => p.min)), yhi = Math.max(...hist.map(p => p.max));
        const pad = Math.max(0.01, (yhi - ylo) * 0.15);
        ylo = Math.floor((ylo - pad) * 100) / 100; yhi = Math.ceil((yhi + pad) * 100) / 100;
        if (yhi - ylo < 0.02) yhi = ylo + 0.02;
        const tx = t => padL + plotW * ((t - t0) / span);
        const ty = v => padT + plotH * (1 - (v - ylo) / (yhi - ylo));

        const topP = hist.map(p => [tx(p.t), ty(p.max)]);
        const botP = hist.map(p => [tx(p.t), ty(p.min)]);
        const band = `<path d="M ${topP.map(p => p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" L ")} L ${botP.slice().reverse().map(p => p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" L ")} Z" fill="url(#gareaGrad)"/>`;

        const lines =
            line(hist.map(p => [tx(p.t), ty(p.max)]), "#f59e0b") +
            line(hist.map(p => [tx(p.t), ty(p.avg)]), "#3b82f6") +
            line(hist.map(p => [tx(p.t), ty(p.min)]), "#22d3ee");

        const legend =
            `<g transform="translate(${padL + 6}, ${padT + 4})">` +
            `<rect x="-4" y="-12" width="150" height="20" rx="6" fill="#eef2f8" opacity="0.8"/>` +
            `<line x1="0" y1="-2" x2="14" y2="-2" style="stroke:#f59e0b;stroke-width:3"/><text x="18" y="2" class="g-legtext">Max</text>` +
            `<line x1="52" y1="-2" x2="66" y2="-2" style="stroke:#3b82f6;stroke-width:3"/><text x="70" y="2" class="g-legtext">Avg</text>` +
            `<line x1="100" y1="-2" x2="114" y2="-2" style="stroke:#22d3ee;stroke-width:3"/><text x="118" y="2" class="g-legtext">Min</text>` +
            `</g>`;

        return yAxis(ylo, yhi, ty, 3) + axis + band + lines + legend + xTime(t0, span, tx) + yTitle("Voltage (V)") + xTitle("Pack Max / Avg / Min over time — the band narrows as it balances");
    }

    // =================================================================
    if (type === "spread") {

        if (hist.length < 2) return collecting;
        const t0 = hist[0].t, t1 = hist[hist.length - 1].t, span = Math.max(1, t1 - t0);
        const target = (typeof BALANCED_DIFF_V === "number") ? BALANCED_DIFF_V : 0.01;
        let yhi = Math.max(target, ...hist.map(p => p.max - p.min)) * 1000;
        yhi = Math.ceil((yhi * 1.15) / 5) * 5 || 10;
        const ty = mv => padT + plotH * (1 - mv / yhi);
        const tx = t => padL + plotW * ((t - t0) / span);

        let grid = "";
        for (let k = 0; k <= 5; k++) {
            const mv = yhi * (k / 5), y = ty(mv);
            grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" class="g-grid"/>`;
            grid += `<text x="${(padL - 8).toFixed(1)}" y="${(y + 4).toFixed(1)}" class="g-ylabel">${mv.toFixed(0)}</text>`;
        }

        const pts = hist.map(p => [tx(p.t), ty((p.max - p.min) * 1000)]);
        const area = `<path d="${smoothArea(pts, baseline)}" fill="url(#gareaGrad)"/>`;
        const curve = line(pts, "#a855f7");

        const tY = ty(target * 1000);
        const targetLine = `<line x1="${padL}" y1="${tY.toFixed(1)}" x2="${W - padR}" y2="${tY.toFixed(1)}" stroke="#34d399" stroke-width="1.5" stroke-dasharray="6 5"/>` +
            `<text x="${(W - padR - 4).toFixed(1)}" y="${(tY - 5).toFixed(1)}" class="g-legtext" style="fill:#34d399" text-anchor="end">balanced target ${(target * 1000).toFixed(0)} mV</text>`;

        return grid + axis + area + curve + targetLine + xTime(t0, span, tx) + yTitle("Spread — Max − Min (mV)") + xTitle("Imbalance closing toward the target");
    }

    // =================================================================
    if (type === "gantt") {

        if (hist.length < 2) return collecting;
        const t0 = hist[0].t, t1 = hist[hist.length - 1].t, span = Math.max(1, t1 - t0);
        const tx = t => padL + plotW * ((t - t0) / span);
        const rowH = plotH / n;
        const stateCol = s => s === 2 ? "#16a34a" : s === 1 ? "#ef4444" : "#33415580";

        let rows = "";
        for (let i = 0; i < n; i++) {
            const y = padT + i * rowH;
            rows += `<rect x="${padL}" y="${(y + 1).toFixed(1)}" width="${plotW}" height="${(rowH - 2).toFixed(1)}" fill="#eef2f8" opacity="0.5"/>`;
            rows += `<text x="${(padL - 6).toFixed(1)}" y="${(y + rowH / 2 + 3).toFixed(1)}" class="g-ylabel" text-anchor="end">C${i + 1}</text>`;

            // Run-length: one rect per contiguous same-state stretch.
            let blkStart = 0;
            for (let k = 1; k <= hist.length; k++) {
                const prevS = hist[k - 1].states ? hist[k - 1].states[i] : 0;
                const curS = k < hist.length && hist[k].states ? hist[k].states[i] : null;
                if (k === hist.length || curS !== prevS) {
                    if (prevS !== 0) {
                        const x1 = tx(hist[blkStart].t), x2 = tx(hist[Math.min(k, hist.length - 1)].t);
                        rows += `<rect x="${x1.toFixed(1)}" y="${(y + 2).toFixed(1)}" width="${Math.max(1.5, x2 - x1).toFixed(1)}" height="${(rowH - 4).toFixed(1)}" rx="2" fill="${stateCol(prevS)}"/>`;
                    }
                    blkStart = k;
                }
            }
        }

        const legend =
            `<g transform="translate(${padL + 6}, ${padT - 2})">` +
            `<rect x="-4" y="-12" width="220" height="18" rx="5" fill="#eef2f8" opacity="0.85"/>` +
            `<rect x="0" y="-9" width="12" height="10" rx="2" fill="#ef4444"/><text x="16" y="-1" class="g-legtext">Discharging</text>` +
            `<rect x="96" y="-9" width="12" height="10" rx="2" fill="#16a34a"/><text x="112" y="-1" class="g-legtext">Charging</text>` +
            `</g>`;

        return rows + legend + xTime(t0, span, tx) + xTitle("When each cell was balancing (per-cell timeline)");
    }

    // =================================================================
    if (type === "energy") {

        const chg = i => (cellChargeCount && cellChargeCount[i]) || 0;
        const dis = i => (cellDischargeCount && cellDischargeCount[i]) || 0;
        let maxCount = 1;
        for (let i = 0; i < n; i++) maxCount = Math.max(maxCount, chg(i), dis(i));

        const midY = padT + plotH / 2;
        const half = plotH / 2 - 16;
        const slotW = plotW / n;
        const barW = Math.min(30, slotW * 0.5);

        let grid = "";
        grid += `<line x1="${padL}" y1="${midY.toFixed(1)}" x2="${W - padR}" y2="${midY.toFixed(1)}" class="g-axis"/>`;
        for (let k = 1; k <= 2; k++) {
            const yUp = midY - half * (k / 2), yDn = midY + half * (k / 2);
            grid += `<line x1="${padL}" y1="${yUp.toFixed(1)}" x2="${W - padR}" y2="${yUp.toFixed(1)}" class="g-grid"/>`;
            grid += `<line x1="${padL}" y1="${yDn.toFixed(1)}" x2="${W - padR}" y2="${yDn.toFixed(1)}" class="g-grid"/>`;
            grid += `<text x="${(padL - 8).toFixed(1)}" y="${(yUp + 4).toFixed(1)}" class="g-ylabel">${Math.round(maxCount * k / 2)}</text>`;
            grid += `<text x="${(padL - 8).toFixed(1)}" y="${(yDn + 4).toFixed(1)}" class="g-ylabel">${Math.round(maxCount * k / 2)}</text>`;
        }

        let bars = "";
        for (let i = 0; i < n; i++) {
            const cx = padL + slotW * (i + 0.5);
            const hUp = (chg(i) / maxCount) * half;
            const hDn = (dis(i) / maxCount) * half;
            if (chg(i)) bars += `<rect x="${(cx - barW / 2).toFixed(1)}" y="${(midY - hUp).toFixed(1)}" width="${barW.toFixed(1)}" height="${hUp.toFixed(1)}" rx="3" fill="url(#ggrad-chg)" style="filter:drop-shadow(0 0 4px #16a34a66)"><title>Cell ${i + 1}: charged ${chg(i)}×</title></rect>`;
            if (dis(i)) bars += `<rect x="${(cx - barW / 2).toFixed(1)}" y="${midY.toFixed(1)}" width="${barW.toFixed(1)}" height="${hDn.toFixed(1)}" rx="3" fill="url(#ggrad-dis)" style="filter:drop-shadow(0 0 4px #ef444466)"><title>Cell ${i + 1}: discharged ${dis(i)}×</title></rect>`;
            bars += `<text x="${cx.toFixed(1)}" y="${(baseline + 18).toFixed(1)}" class="g-xlabel">${i + 1}</text>`;
        }

        const legend =
            `<g transform="translate(${padL + 6}, ${padT + 4})">` +
            `<rect x="-4" y="-12" width="240" height="20" rx="6" fill="#eef2f8" opacity="0.8"/>` +
            `<rect x="0" y="-10" width="12" height="10" rx="2" fill="#16a34a"/><text x="16" y="-1" class="g-legtext">▲ Charged (receiver)</text>` +
            `<rect x="128" y="-10" width="12" height="10" rx="2" fill="#ef4444"/><text x="144" y="-1" class="g-legtext">▼ Discharged (donor)</text>` +
            `</g>`;

        return grid + bars + legend + yTitle("Times balanced (count)") + xTitle("Energy moved per cell — donors vs receivers");
    }

    // =================================================================
    if (type === "deviation") {

        const vals = cellVoltages.slice();
        if (!vals.length) return collecting;
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
        const order = vals.map((_, i) => i).sort((a, b) => Math.abs(vals[b] - avg) - Math.abs(vals[a] - avg));
        let maxAbs = 0.005;
        for (let i = 0; i < n; i++) maxAbs = Math.max(maxAbs, Math.abs(vals[i] - avg));

        const midY = padT + plotH / 2;
        const scale = (plotH / 2 - 16) / maxAbs;
        const slotW = plotW / n;
        const barW = Math.min(30, slotW * 0.55);

        let grid = `<line x1="${padL}" y1="${midY.toFixed(1)}" x2="${W - padR}" y2="${midY.toFixed(1)}" class="g-axis"/>`;
        grid += `<text x="${(padL + 4).toFixed(1)}" y="${(midY - 5).toFixed(1)}" class="g-legtext" style="fill:#93a1b5">Pack average (0 mV)</text>`;
        for (let k = 1; k <= 2; k++) {
            const dev = maxAbs * (k / 2) * 1000;
            const yU = midY - (dev / 1000) * scale, yD = midY + (dev / 1000) * scale;
            grid += `<line x1="${padL}" y1="${yU.toFixed(1)}" x2="${W - padR}" y2="${yU.toFixed(1)}" class="g-grid"/><text x="${(padL - 8).toFixed(1)}" y="${(yU + 4).toFixed(1)}" class="g-ylabel">+${dev.toFixed(0)}</text>`;
            grid += `<line x1="${padL}" y1="${yD.toFixed(1)}" x2="${W - padR}" y2="${yD.toFixed(1)}" class="g-grid"/><text x="${(padL - 8).toFixed(1)}" y="${(yD + 4).toFixed(1)}" class="g-ylabel">-${dev.toFixed(0)}</text>`;
        }

        let bars = "";
        order.forEach((i, slot) => {
            const cx = padL + slotW * (slot + 0.5);
            const dev = vals[i] - avg;
            const h = Math.abs(dev) * scale;
            const y = dev >= 0 ? midY - h : midY;
            const col = GRAPH_GROUP_COLOR[graphCellGroup(i)];
            bars += `<rect x="${(cx - barW / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="3" fill="${col}" style="filter:drop-shadow(0 0 4px ${col}66)"><title>Cell ${i + 1}: ${dev >= 0 ? "+" : ""}${(dev * 1000).toFixed(0)} mV</title></rect>`;
            bars += `<text x="${cx.toFixed(1)}" y="${(baseline + 18).toFixed(1)}" class="g-xlabel">${i + 1}</text>`;
        });

        return grid + bars + yTitle("Deviation from average (mV)") + xTitle("Each cell vs the pack average — biggest outliers first");
    }

    // =================================================================
    if (type === "histogram") {

        const vals = cellVoltages.slice().filter(v => v > 0);
        if (vals.length < 2) return collecting;
        let lo = Math.min(...vals), hi = Math.max(...vals);
        if (hi - lo < 0.001) { lo -= 0.005; hi += 0.005; }
        const bins = Math.min(10, Math.max(5, Math.round(Math.sqrt(n))));
        const binW = (hi - lo) / bins;
        const counts = new Array(bins).fill(0);
        vals.forEach(v => { let b = Math.floor((v - lo) / binW); if (b < 0) b = 0; if (b >= bins) b = bins - 1; counts[b]++; });
        const maxC = Math.max(1, ...counts);

        const slotW = plotW / bins;
        const barW = slotW * 0.82;

        let grid = "";
        for (let k = 0; k <= maxC; k++) {
            const y = baseline - (k / maxC) * plotH;
            grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" class="g-grid"/>`;
            grid += `<text x="${(padL - 8).toFixed(1)}" y="${(y + 4).toFixed(1)}" class="g-ylabel">${k}</text>`;
        }

        let bars = "";
        for (let b = 0; b < bins; b++) {
            const x = padL + slotW * b + (slotW - barW) / 2;
            const h = (counts[b] / maxC) * plotH;
            bars += `<rect x="${x.toFixed(1)}" y="${(baseline - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="4" fill="url(#gareaGrad2)" stroke="#22d3ee" stroke-width="1" style="filter:drop-shadow(0 0 5px #22d3ee55)"><title>${(lo + b * binW).toFixed(3)}–${(lo + (b + 1) * binW).toFixed(3)} V: ${counts[b]} cells</title></rect>`;
            if (b % 2 === 0 || bins <= 6)
                bars += `<text x="${(padL + slotW * (b + 0.5)).toFixed(1)}" y="${(baseline + 18).toFixed(1)}" class="g-xlabel">${(lo + (b + 0.5) * binW).toFixed(3)}</text>`;
        }

        const gdef = `<linearGradient id="gareaGrad2" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#22d3ee" stop-opacity="0.85"/><stop offset="100%" stop-color="#3b82f6" stop-opacity="0.45"/></linearGradient>`;

        return gdef + `<line x1="${padL}" y1="${baseline}" x2="${W - padR}" y2="${baseline}" class="g-axis"/>` + grid + bars + yTitle("Number of cells") + xTitle("Voltage distribution — a tight peak means a balanced pack");
    }

    // =================================================================
    if (type === "multiples") {

        // Small multiples — a grid of one mini line-chart PER cell, so every
        // cell is shown separately (its own panel) at the same time.
        if (hist.length < 2) return collecting;
        const t0 = hist[0].t, t1 = hist[hist.length - 1].t, span = Math.max(1, t1 - t0);

        const cols = Math.ceil(Math.sqrt(n));
        const rows = Math.ceil(n / cols);
        const gx = 8, gy = 8;
        const x0 = 34, y0 = 14, x1 = W - 12, y1 = H - 10;
        const cw = (x1 - x0 - gx * (cols - 1)) / cols;
        const ch = (y1 - y0 - gy * (rows - 1)) / rows;

        let out = "";
        for (let i = 0; i < n; i++) {
            const r = Math.floor(i / cols), c = i % cols;
            const bx = x0 + c * (cw + gx), by = y0 + r * (ch + gy);
            const col = GRAPH_GROUP_COLOR[graphCellGroup(i)];

            out += `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${cw.toFixed(1)}" height="${ch.toFixed(1)}" rx="6" fill="#eef2f8" opacity="0.55" stroke="#e2e8f0" stroke-width="1"/>`;

            const pp = hist.filter(p => p.cells && p.cells[i] !== undefined);
            if (pp.length >= 2) {
                let lo = Math.min(...pp.map(p => p.cells[i])), hi = Math.max(...pp.map(p => p.cells[i]));
                const pad = Math.max(0.005, (hi - lo) * 0.2);
                lo -= pad; hi += pad; if (hi - lo < 0.01) hi = lo + 0.01;
                const top = by + 20, bot = by + ch - 6, left = bx + 6, right = bx + cw - 6;
                const mx = t => left + (right - left) * ((t - t0) / span);
                const my = v => top + (bot - top) * (1 - (v - lo) / (hi - lo));
                const line = pp.map(p => [mx(p.t), my(p.cells[i])]);
                out += `<path d="${smoothD(line)}" fill="none" stroke="${col}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" style="filter:drop-shadow(0 0 2px ${col}88)"/>`;
                const last = line[line.length - 1];
                out += `<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.4" fill="${col}"/>`;
            }

            const cur = (cellVoltages[i] !== undefined) ? cellVoltages[i] : 0;
            out += `<text x="${(bx + 6).toFixed(1)}" y="${(by + 13).toFixed(1)}" style="fill:${col};font-size:11px;font-weight:800">C${i + 1}</text>`;
            out += `<text x="${(bx + cw - 6).toFixed(1)}" y="${(by + 13).toFixed(1)}" text-anchor="end" style="fill:#111827;font-size:10.5px;font-weight:700">${cur.toFixed(3)}</text>`;
        }

        return out;
    }

    return collecting;
}

// Compact inline voltage-trend chart shown below the cells on the dashboard —
// pack Max / Avg / Min over time. Drawn every tick from graphHistory.
function renderInlineTrend() {

    const el = document.getElementById("graphInline");
    if (!el) return;

    const W = 900, H = 200, padL = 46, padR = 16, padT = 14, padB = 26;
    const plotW = W - padL - padR, plotH = H - padT - padB, baseline = padT + plotH;

    const hist = graphHistory.slice();
    if (hist.length < 2) {
        el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="graph-svg" preserveAspectRatio="none"><text x="${W / 2}" y="${H / 2}" text-anchor="middle" style="fill:#94a3b8;font-size:13px">Collecting trend… start balancing or wait a few seconds</text></svg>`;
        return;
    }

    const t0 = hist[0].t, t1 = hist[hist.length - 1].t, span = Math.max(1, t1 - t0);
    let ylo = Math.min(...hist.map(p => p.min)), yhi = Math.max(...hist.map(p => p.max));
    const pad = Math.max(0.01, (yhi - ylo) * 0.15);
    ylo = Math.floor((ylo - pad) * 100) / 100; yhi = Math.ceil((yhi + pad) * 100) / 100;
    if (yhi - ylo < 0.02) yhi = ylo + 0.02;

    const tx = t => padL + plotW * ((t - t0) / span);
    const ty = v => padT + plotH * (1 - (v - ylo) / (yhi - ylo));

    let grid = "";
    for (let k = 0; k <= 4; k++) {
        const v = ylo + (yhi - ylo) * (k / 4), y = ty(v);
        grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="#eef2f7" stroke-width="1"/>`;
        grid += `<text x="${padL - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" style="fill:#94a3b8;font-size:10px">${v.toFixed(2)}</text>`;
    }
    let xlab = "";
    for (let k = 0; k <= 4; k++) {
        const tt = t0 + span * (k / 4), secs = Math.round((t1 - tt) / 1000);
        xlab += `<text x="${tx(tt).toFixed(1)}" y="${(baseline + 16).toFixed(1)}" text-anchor="middle" style="fill:#94a3b8;font-size:10px">${secs === 0 ? "now" : "-" + secs + "s"}</text>`;
    }

    const line = (key, col) => `<path d="${smoothD(hist.map(p => [tx(p.t), ty(p[key])]))}" fill="none" stroke="${col}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`;
    const lines = line("max", "#ef4444") + line("avg", "#2563eb") + line("min", "#16a34a");

    const legend =
        `<g transform="translate(${padL + 4},${padT + 2})">` +
        `<circle cx="4" cy="0" r="4" fill="#ef4444"/><text x="12" y="4" style="fill:#475569;font-size:11px">Max</text>` +
        `<circle cx="54" cy="0" r="4" fill="#2563eb"/><text x="62" y="4" style="fill:#475569;font-size:11px">Avg</text>` +
        `<circle cx="102" cy="0" r="4" fill="#16a34a"/><text x="110" y="4" style="fill:#475569;font-size:11px">Min</text>` +
        `</g>`;

    const axis = `<line x1="${padL}" y1="${baseline}" x2="${W - padR}" y2="${baseline}" stroke="#cbd5e1" stroke-width="1.2"/>`;

    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="graph-svg" preserveAspectRatio="none">${grid}${axis}${lines}${legend}${xlab}</svg>`;
}

function renderGraph() {

    if (!graphOpen) return;

    const body = document.getElementById("graphBody");
    const summaryEl = document.getElementById("graphSummary");
    const detailEl = document.getElementById("graphDetail");

    if (!body) return;

    const n = CELL_COUNT;
    const values = cellVoltages.slice();

    // A selection made before the pack was shrunk can point past the end now —
    // drop it so the detail panel never reads an out-of-range cell.
    if (selectedGraphCell !== null && selectedGraphCell >= n) selectedGraphCell = null;

    if (!values.length || Math.max(...values) <= 0) {

        body.innerHTML = `<p class="graph-empty">No cell data yet — waiting for readings…</p>`;
        if (summaryEl) summaryEl.innerHTML = "";
        if (detailEl) detailEl.innerHTML = `<span class="gd-hint">No cell data yet.</span>`;

        return;

    }

    const maxV = Math.max(...values);
    const minV = Math.min(...values);
    const maxCell = values.indexOf(maxV);
    const minCell = values.indexOf(minV);
    const avgV = values.reduce((a, b) => a + b, 0) / n;

    // Bucket every cell by colour group + collect the fault sets.
    const groups = { normal: [], dis: [], chg: [] };
    const ovCells = [], uvCells = [], critCells = [];

    for (let i = 0; i < n; i++) {
        groups[graphCellGroup(i)].push(i + 1);
        if (cellOVFault[i]) ovCells.push(i + 1);
        if (cellUVFault[i]) uvCells.push(i + 1);
        if (cellOVFault[i] || cellUVFault[i]) critCells.push(i + 1);
    }

    // ---- Selectable state / fault chips — click one to show only those cells ----
    if (summaryEl) {

        const cellStr = cells => cells.length
            ? (cells.length <= 6 ? cells.join(", ") : cells.slice(0, 6).join(", ") + "…")
            : "—";

        const chip = (key, name, color, cells) =>
            `<button class="gsum-chip${graphHighlightGroup === key ? " active" : ""}" style="--gc:${color}" onclick="toggleGraphGroup('${key}')" title="Show only ${name} cells">
                <span class="gsum-dot"></span>
                <span class="gsum-name">${name}</span>
                <span class="gsum-count">${cells.length}</span>
                <span class="gsum-cells">${cellStr(cells)}</span>
            </button>`;

        let html =
            chip("dis", "Discharging", GRAPH_GROUP_COLOR.dis, groups.dis) +
            chip("chg", "Charging", GRAPH_GROUP_COLOR.chg, groups.chg) +
            chip("normal", "Normal", GRAPH_GROUP_COLOR.normal, groups.normal);

        // Fault filters — only shown when there are such cells.
        if (ovCells.length) html += chip("ov", "⚠ Over-Voltage", "#dc2626", ovCells);
        if (uvCells.length) html += chip("uv", "⚠ Under-Voltage", "#d97706", uvCells);
        if (critCells.length) html += chip("critical", "⛔ Critical", "#b91c1c", critCells);

        summaryEl.innerHTML = html;

    }

    // ---- Key-stat cards + subtitle ----
    const spread = maxV - minV;

    const subtitleEl = document.getElementById("graphSubtitle");
    if (subtitleEl) {
        const pack = getPackNo();
        const now = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
        subtitleEl.textContent =
            `${n} cells · ${simulationEnabled ? "Simulated" : "Real-device"} data` +
            (pack ? ` · Pack ${pack}` : "") + ` · updated ${now}`;
    }

    // Pack health badge in the header.
    const badgeEl = document.getElementById("graphHealth");
    if (badgeEl) {
        const h = packHealth();
        badgeEl.className = "graph-health " + h.cls;
        badgeEl.textContent = h.label;
    }

    // Keep the "Show" dropdown in sync with the current selection / filter.
    populateCellSelect();
    const cellSel = document.getElementById("graphCellSelect");
    if (cellSel) cellSel.value = currentShowValue();

    // Quick cell navigation strip (single-cell view only).
    renderGraphCellNav();

    // Limit / threshold panel shown OUTSIDE the chart.
    const limEl = document.getElementById("graphLimits");
    if (limEl) {
        const ov = parseFloat(document.getElementById("ovProtection")?.value);
        const uv = parseFloat(document.getElementById("uvProtection")?.value);
        const startv = parseFloat(document.getElementById("eqLow")?.value);
        const val = v => isNaN(v) ? "—" : v.toFixed(3) + " V";
        const chip = (col, name, v) =>
            `<span class="glim-chip"><span class="glim-dot" style="background:${col}"></span>` +
            `<span class="glim-name">${name}</span><span class="glim-val">${v}</span></span>`;

        limEl.innerHTML =
            chip("#f87171", "OV limit", val(ov)) +
            chip("#fbbf24", "UV limit", val(uv)) +
            chip("#60a5fa", "Pack avg", val(avgV)) +
            chip("#cbd5e1", "Start V", val(startv)) +
            chip("#f59e0b", "Spread", val(maxV - minV));
    }

    // Plain-language explanation of the current view, so it's understandable
    // without prior knowledge.
    const helpEl = document.getElementById("graphHelp");
    if (helpEl) {
        if (graphChart) {
            const chartHelp = {
                multiples: "🔲 Every cell shown separately — a grid of 16 mini-charts, one per cell, each plotting that cell's voltage over the session (line colour = state). Scan them all at once; the number top-right is the live voltage.",
                convergence: "📉 Pack Max, Average and Min voltage over time. The shaded band between Max and Min narrows as the cells come together — a thin band means balanced.",
                spread: "📈 The imbalance (Max − Min) in mV over time, heading down toward the balanced target (dashed line). How fast it drops shows how well balancing is working.",
                gantt: "📊 A timeline per cell: coloured blocks show when each cell was discharging (red) or charging (green). Blank = idle. Reveals which cells did the work and the duty-cycle rhythm.",
                energy: "⚡ How many times each cell charged (green, up = receiver) vs discharged (yellow, down = donor) this session. Tall yellow bars are the pack's high cells; tall green bars are the low ones.",
                deviation: "🎯 Each cell's distance from the pack average (mV), biggest outliers first. Bars above the line are high (will discharge); below are low (will charge). Bar colour = state.",
                histogram: "📶 How the 16 cells are distributed across voltage. A tight, tall peak = a well-balanced pack; a wide spread = cells still out of balance."
            };
            helpEl.textContent = chartHelp[graphChart] || "";
        } else if (selectedGraphCell !== null) {
            helpEl.textContent = `📈 Cell ${selectedGraphCell + 1}: voltage over time as one trend line — dotted grey while the cell was resting (idle), solid coloured with a filled area while it was being balanced. The dashed marker shows where balancing started; each dot is one reading.`;
        } else if (graphHighlightGroup === "chg") {
            helpEl.textContent = "⚡ Only the charging cells, as bars — each bar is one cell's current voltage (green). The avg / OV / UV level lines show where the limits sit. Tap a bar to open that cell.";
        } else if (graphHighlightGroup === "dis") {
            helpEl.textContent = "🔻 Only the discharging cells, as bars — each bar is one cell's current voltage (yellow). The avg / OV / UV level lines show where the limits sit. Tap a bar to open that cell.";
        } else if (graphHighlightGroup === "warning") {
            helpEl.textContent = "⚠ Only the WARNING cells (out of balance — more than 30 mV from the pack average). Bar height = voltage; the level lines (avg / start / OV / UV) show where each threshold sits.";
        } else if (graphHighlightGroup === "critical") {
            helpEl.textContent = "⛔ Only the CRITICAL cells (in an over- or under-voltage fault). Bar height = voltage; the OV / UV level lines show the limits they crossed.";
        } else if (graphHighlightGroup === "normal") {
            helpEl.textContent = "🟡 All 16 cells as bars. Bar colour shows state (green charging, yellow discharging, pink normal); the level lines mark avg / start / OV / UV.";
        } else {
            const help = {
                voltage: "📊 Each bar is one cell's voltage. Taller bar = higher voltage; bar colour shows its state. Bars standing apart from the group are the ones out of balance.",
                sorted: "📉 The same bars lined up highest → lowest, so the strongest and weakest cells are easy to spot.",
                deviation: "🎯 How far each cell is from the pack AVERAGE (in mV). Dots ABOVE the middle line are higher than average (will discharge); dots BELOW are lower (will charge). A balanced pack has every dot hugging the line."
            };
            helpEl.textContent = help[graphView] || "";
        }
    }

    const statsEl = document.getElementById("graphStats");
    if (statsEl) {

        const card = (label, value, sub, cls) =>
            `<div class="gstat ${cls}">
                <span class="gstat-label">${label}</span>
                <span class="gstat-value">${value}</span>
                <span class="gstat-sub">${sub}</span>
            </div>`;

        statsEl.innerHTML =
            card("Average", avgV.toFixed(3) + " V", "pack mean", "gs-avg") +
            card("Highest", maxV.toFixed(3) + " V", "Cell " + (maxCell + 1), "gs-high") +
            card("Lowest", minV.toFixed(3) + " V", "Cell " + (minCell + 1), "gs-low") +
            card("Spread", spread.toFixed(3) + " V", "max − min", "gs-spread");

    }

    // ---- The chart ----
    const W = 820, H = 420;
    const padL = 66, padR = 205, padT = 34, padB = 60;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const baseline = padT + plotH;
    const barW = Math.max(5, (plotW / n) * 0.6);
    const rTop = Math.min(6, barW / 2);

    // Draw order: "sorted" = high → low; "deviation" = biggest outliers first
    // (by absolute distance from the average); the others keep 1..n.
    let order = Array.from({ length: n }, (_, k) => k);
    if (graphView === "sorted") order = order.slice().sort((a, b) => values[b] - values[a]);
    else if (graphView === "deviation") order = order.slice().sort((a, b) => Math.abs(values[b] - avgV) - Math.abs(values[a] - avgV));

    const slotOf = new Array(n);
    order.forEach((cellIdx, slot) => { slotOf[cellIdx] = slot; });
    const xSlot = slot => padL + (plotW / n) * (slot + 0.5);

    // Shared gradients, shadow, and the flow arrowhead.
    const defs =
        `<defs>` +
        // Bar gradients: the state colours PLUS over-voltage (red) and
        // under-voltage (amber), so a faulted cell's bar changes colour.
        Object.entries({ ...GRAPH_GROUP_COLOR, ov: "#ef4444", uv: "#f59e0b", lvnormal: "#22c55e", lvhigh: "#f5c518", lvveryhigh: "#ef4444", lvlow: "#3b82f6" }).map(([gk, c]) => {
            return `<linearGradient id="ggrad-${gk}" x1="0" y1="0" x2="0" y2="1">` +
                   `<stop offset="0%" stop-color="${graphLighten(c, 0.5)}"/>` +
                   `<stop offset="55%" stop-color="${c}"/>` +
                   `<stop offset="100%" stop-color="${graphLighten(c, -0.15) || c}"/></linearGradient>`;
        }).join("") +
        `<filter id="gbarShadow" x="-40%" y="-15%" width="180%" height="135%"><feDropShadow dx="0" dy="2" stdDeviation="2.2" flood-color="#0f172a" flood-opacity="0.16"/></filter>` +
        `<filter id="gGlow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="3.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>` +
        `<marker id="gflow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#7c3aed"/></marker>` +
        `<linearGradient id="gareaGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#2563eb" stop-opacity="0.30"/><stop offset="100%" stop-color="#2563eb" stop-opacity="0.02"/></linearGradient>` +
        `</defs>`;

    const cellLabels = () => {
        let s = "";
        for (let slot = 0; slot < n; slot++) {
            const i = order[slot];
            const isSel = selectedGraphCell === i;
            s += `<text x="${xSlot(slot).toFixed(1)}" y="${(baseline + 18).toFixed(1)}" class="g-xlabel${isSel ? " g-xlabel-sel" : ""}">${i + 1}</text>`;
        }
        return s;
    };

    let svgInner = "";

    if (graphChart) {

        // --- One of the six session-analysis charts ---
        svgInner = renderAnalysisChart(graphChart, { W, H, padL, padR, padT, padB, plotW, plotH, baseline, n });

    }

    else if (selectedGraphCell !== null) {

        // --- Single cell over time: idle voltage vs balancing voltage ---
        const ci = selectedGraphCell;
        const hist = graphHistory.slice().filter(p => p.cells && p.cells[ci] !== undefined);

        if (hist.length < 2) {

            svgInner = `<text x="${W / 2}" y="${H / 2}" class="g-axistitle" text-anchor="middle">Collecting Cell ${ci + 1} data… keep the graph open for a few seconds</text>`;

        } else {

            const t0 = hist[0].t, t1 = hist[hist.length - 1].t;
            const span = Math.max(1, t1 - t0);

            // Shared voltage scale from ALL of this cell's readings, so Idle
            // and Balancing sit on the SAME axis and can be compared directly.
            const cvals = hist.map(p => p.cells[ci]);
            let ylo = Math.min(...cvals), yhi = Math.max(...cvals);
            const padYv = Math.max(0.01, (yhi - ylo) * 0.2);
            ylo = Math.floor((ylo - padYv) * 100) / 100;
            yhi = Math.ceil((yhi + padYv) * 100) / 100;
            if (yhi - ylo < 0.02) yhi = ylo + 0.02;

            const tx = t => padL + plotW * ((t - t0) / span);
            const ty = v => padT + plotH * (1 - (v - ylo) / (yhi - ylo));

            let grid = "";
            for (let k = 0; k <= 5; k++) {
                const v = ylo + (yhi - ylo) * (k / 5);
                const y = ty(v);
                grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" class="g-grid"/>`;
                grid += `<text x="${(padL - 8).toFixed(1)}" y="${(y + 4).toFixed(1)}" class="g-ylabel">${v.toFixed(3)}</text>`;
            }

            let xlab = "";
            for (let k = 0; k <= 4; k++) {
                const tt = t0 + span * (k / 4);
                const secsAgo = Math.round((t1 - tt) / 1000);
                xlab += `<text x="${tx(tt).toFixed(1)}" y="${(baseline + 18).toFixed(1)}" class="g-xlabel">${secsAgo === 0 ? "now" : "-" + secsAgo + "s"}</text>`;
            }

            // Voltage samples tagged with the cell's state (0 idle, 1 dis, 2 chg).
            const pts = hist.map(p => ({ t: p.t, v: p.cells[ci], s: p.states ? p.states[ci] : 0 }));
            const IDLE_COL = "#94a3b8";
            const chgN = pts.filter(p => p.s === 2).length;
            const disN = pts.filter(p => p.s === 1).length;
            const BAL_COL = chgN > disN ? "#16a34a" : "#ef4444";

            // ONE continuous trend line, split into contiguous runs by state:
            // idle = dotted grey, balancing = solid coloured line + area fill.
            // Each new run starts at the previous point so the line never breaks.
            const P = pts.map(p => ({ x: tx(p.t), y: ty(p.v), c: p.s === 0 ? 0 : 1, v: p.v, t: p.t }));
            const runs = [];
            for (let k = 0; k < P.length; k++) {
                const p = P[k];
                const last = runs[runs.length - 1];
                if (!last || last.c !== p.c) {
                    const run = { c: p.c, pts: [] };
                    if (k > 0) run.pts.push(P[k - 1]);   // bridge from the previous reading
                    run.pts.push(p);
                    runs.push(run);
                } else {
                    last.pts.push(p);
                }
            }

            let series = "";
            runs.forEach((run, ri) => {
                const xy = run.pts.map(p => [p.x, p.y]);
                if (xy.length < 2) return;
                if (run.c === 1) {
                    const gid = `gbal-${ri}`;
                    series += `<linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${BAL_COL}" stop-opacity="0.30"/><stop offset="100%" stop-color="${BAL_COL}" stop-opacity="0.02"/></linearGradient>`;
                    series += `<path d="${smoothArea(xy, baseline)}" fill="url(#${gid})"/>`;
                    series += `<path d="${smoothD(xy)}" fill="none" stroke="${BAL_COL}" stroke-width="2.8" stroke-linejoin="round" stroke-linecap="round" class="${graphAnimate ? "g-anim-draw" : ""}"/>`;
                } else {
                    series += `<path d="${smoothD(xy)}" fill="none" stroke="${IDLE_COL}" stroke-width="2.4" stroke-dasharray="2 5" stroke-linejoin="round" stroke-linecap="round"/>`;
                }
            });

            // Small dot at every reading — white core, ring coloured by state.
            let dots = "";
            P.forEach(p => {
                const col = p.c === 1 ? BAL_COL : IDLE_COL;
                dots += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.6" fill="#ffffff" stroke="${col}" stroke-width="1.6"/>`;
            });

            // "Balancing Started" marker at the first idle → balancing transition.
            // Label sits BELOW the legend row (which lives near padT) and flips to
            // the left of the line when the marker is close to the right edge so it
            // never runs off the plot or collides with the legend.
            let marker = "";
            const firstBal = P.findIndex((p, k) => p.c === 1 && (k === 0 || P[k - 1].c === 0));
            if (firstBal > 0) {
                const mx = P[firstBal].x;
                const lblY = padT + 40;
                const flip = mx > padL + plotW * 0.6;
                const anchor = flip ? "end" : "start";
                const tx0 = flip ? mx - 8 : mx + 8;
                const label = "Balancing Started";
                const boxW = 118, boxH = 18;
                const boxX = flip ? tx0 - boxW : tx0;
                marker = `<line x1="${mx.toFixed(1)}" y1="${(padT + 26).toFixed(1)}" x2="${mx.toFixed(1)}" y2="${baseline}" stroke="${BAL_COL}" stroke-width="1.2" stroke-dasharray="4 4" opacity="0.65"/>` +
                    `<rect x="${boxX.toFixed(1)}" y="${(lblY - 13).toFixed(1)}" width="${boxW}" height="${boxH}" rx="5" fill="#ffffff" opacity="0.9"/>` +
                    `<text x="${tx0.toFixed(1)}" y="${lblY.toFixed(1)}" text-anchor="${anchor}" class="g-legtext" style="fill:${BAL_COL}">${label}</text>`;
            }

            // Crosshair still maps cursor-x → nearest idle / balancing reading.
            const catPts = pred => pts.filter(p => pred(p.s)).map(p => ({ x: tx(p.t), y: ty(p.v), v: p.v, t: p.t }));
            const idleArr = catPts(s => s === 0);
            const balArr = catPts(s => s !== 0);
            graphCrosshairData = {
                padL, plotW, padT, baseline,
                idle: idleArr, bal: balArr,
                idleCol: IDLE_COL, balCol: BAL_COL, t0, span
            };

            // Transparent overlay captures pointer moves; the crosshair group
            // (drawn on top, non-interactive) shows the vertical line + tooltip.
            const hoverLayer =
                `<rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent" style="cursor:crosshair" onpointermove="graphCrosshair(event)" onpointerdown="graphCrosshair(event)" onpointerleave="graphCrosshairClear()"/>` +
                `<g id="graphCrosshairG" style="pointer-events:none"></g>`;

            // Glowing, pulsing "live" dot + value pill on the latest reading.
            const lp = pts[pts.length - 1];
            const lx = tx(lp.t), ly = ty(lp.v), lc = lp.s === 0 ? IDLE_COL : BAL_COL;
            const liveDot =
                `<circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="6" fill="none" stroke="${lc}" stroke-width="2" class="g-livepulse"/>` +
                `<circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="5" fill="${lc}" class="g-livedot"/>`;
            // Value pill sits to the LEFT of the live dot (inside the plot) so it
            // never collides with the right-hand legend.
            const endLbl =
                `<g transform="translate(${lx.toFixed(1)}, ${ly.toFixed(1)})">` +
                `<rect x="-74" y="-12" width="62" height="24" rx="7" fill="${lc}"/>` +
                `<text x="-43" y="4" text-anchor="middle" style="fill:#fff;font-weight:800;font-size:12px">${lp.v.toFixed(3)} V</text>` +
                `</g>`;

            // Legend on the RIGHT side of the graph, stacked line by line with
            // clear spacing between the two entries (vertically centred).
            const legX = W - padR + 34;              // clear horizontal gap from the plot
            const legGap = 56;                       // vertical space between entries
            const legY = padT + plotH / 2 - legGap / 2;
            const legend =
                `<g transform="translate(${legX.toFixed(1)}, ${legY.toFixed(1)})">` +
                `<line x1="0" y1="0" x2="18" y2="0" style="stroke:${IDLE_COL};stroke-width:3;stroke-dasharray:2 4"/>` +
                `<text x="26" y="4" class="g-legtext">Idle (No Balancing)</text>` +
                `<line x1="0" y1="${legGap}" x2="18" y2="${legGap}" style="stroke:${BAL_COL};stroke-width:3"/>` +
                `<text x="26" y="${legGap + 4}" class="g-legtext">Balancing Active</text>` +
                `</g>`;

            const axis = `<line x1="${padL}" y1="${baseline}" x2="${W - padR}" y2="${baseline}" class="g-axis"/>`;
            const yTitle = `<text x="16" y="${(padT + plotH / 2).toFixed(1)}" class="g-axistitle" transform="rotate(-90 16 ${(padT + plotH / 2).toFixed(1)})">Voltage (V)</text>`;
            const xTitle = `<text x="${(padL + plotW / 2).toFixed(1)}" y="${H - 8}" class="g-axistitle">Cell ${ci + 1} — Voltage Trend (idle vs balancing)</text>`;

            svgInner = grid + axis + marker + series + dots + liveDot + endLbl + legend + xlab + yTitle + xTitle + hoverLayer;

        }

    }

    else if (graphHighlightGroup === "chg" || graphHighlightGroup === "dis") {

        // --- BAR chart of only the charging (or discharging) cells: one bar
        // per cell = its current voltage. No overlapping lines. ---
        const isChg = graphHighlightGroup === "chg";
        const label = isChg ? "Charging" : "Discharging";

        const targetCells = [];
        for (let i = 0; i < n; i++) {
            const took = isChg ? cellChargeCount[i] > 0 : cellDischargeCount[i] > 0;
            const now = isChg ? cellCharging[i] : cellBalancing[i];
            if (took || now) targetCells.push(i);
        }

        if (!targetCells.length) {

            svgInner = `<text x="${W / 2}" y="${H / 2}" class="g-axistitle" text-anchor="middle">No ${label.toLowerCase()} cells yet</text>`;

        } else {

            const m = targetCells.length;
            const vlist = targetCells.map(i => values[i]);
            const ovV = parseFloat(document.getElementById("ovProtection")?.value);
            const uvV = parseFloat(document.getElementById("uvProtection")?.value);

            // Include avg / OV / UV in the range so every level line shows.
            const scaleVals = vlist.concat([avgV, ovV, uvV].filter(v => !isNaN(v)));
            let lo = Math.floor((Math.min(...scaleVals) - 0.03) * 100) / 100;
            let hi = Math.ceil((Math.max(...scaleVals) + 0.03) * 100) / 100;
            if (lo < 0) lo = 0;
            if (hi - lo < 0.1) hi = lo + 0.1;
            const yOf = v => padT + plotH * (1 - (v - lo) / (hi - lo));

            let grid = "";
            for (let t = 0; t <= 5; t++) {
                const v = lo + (hi - lo) * (t / 5);
                const y = yOf(v);
                grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" class="g-grid"/>`;
                grid += `<text x="${padL - 8}" y="${(y + 4).toFixed(1)}" class="g-ylabel">${v.toFixed(3)}</text>`;
            }

            // Bright, clearly-labelled level lines (dark pill behind each label).
            const refLine = graphRefLine(lo, hi, yOf, padL, padR, W);
            let refs = "";
            refs += refLine(avgV, "#60a5fa", "avg " + avgV.toFixed(3), "right");
            refs += refLine(ovV, "#f87171", "OV " + (isNaN(ovV) ? "" : ovV.toFixed(3)), "right");
            refs += refLine(uvV, "#fbbf24", "UV " + (isNaN(uvV) ? "" : uvV.toFixed(3)), "left");

            const slotW = plotW / m;
            const barW = Math.min(50, slotW * 0.6);

            let bars = "";
            targetCells.forEach((i, slot) => {
                const cx = padL + slotW * (slot + 0.5);
                const y = yOf(values[i]);
                const g = graphCellGroup(i);
                const c = GRAPH_GROUP_COLOR[g];
                const isSel = selectedGraphCell === i;
                const h = Math.max(1, baseline - y);
                const x = cx - barW / 2;

                const grow = graphAnimate
                    ? `<animate attributeName="height" from="0" to="${h.toFixed(1)}" dur="0.7s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.25 1 0.5 1"/><animate attributeName="y" from="${baseline.toFixed(1)}" to="${y.toFixed(1)}" dur="0.7s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.25 1 0.5 1"/>`
                    : "";

                bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="5" ry="5" class="g-bar${isSel ? " sel" : ""}" fill="url(#ggrad-${g})" style="filter:drop-shadow(0 0 5px ${c}66);cursor:pointer" onclick="selectGraphCell(${i})"><title>Cell ${i + 1}: ${values[i].toFixed(3)} V</title>${grow}</rect>`;
                bars += `<text x="${cx.toFixed(1)}" y="${(y - 7).toFixed(1)}" class="g-vlabel${isSel ? " g-vlabel-sel" : ""}">${values[i].toFixed(3)}</text>`;
                bars += `<text x="${cx.toFixed(1)}" y="${(baseline + 18).toFixed(1)}" class="g-xlabel${isSel ? " g-xlabel-sel" : ""}">${i + 1}</text>`;
            });

            const axis = `<line x1="${padL}" y1="${baseline}" x2="${W - padR}" y2="${baseline}" class="g-axis"/>`;
            const yTitle = `<text x="16" y="${(padT + plotH / 2).toFixed(1)}" class="g-axistitle" transform="rotate(-90 16 ${(padT + plotH / 2).toFixed(1)})">Voltage (V)</text>`;
            const xTitle = `<text x="${(padL + plotW / 2).toFixed(1)}" y="${H - 8}" class="g-axistitle">${label} cells — current voltage</text>`;

            svgInner = grid + refs + axis + bars + yTitle + xTitle;

        }

    }

    else if (graphView === "trend") {

        // --- Trend over time: Max / Average / Min converging = balancing works ---
        const hist = graphHistory.slice();

        if (hist.length < 2) {

            body.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="graph-svg"><text x="${W / 2}" y="${H / 2}" class="g-axistitle" text-anchor="middle">Collecting trend… keep the graph open for a few seconds</text></svg>`;

            if (detailEl) renderGraphDetail(detailEl, values, avgV, maxCell, minCell);
            return;

        }

        const t0 = hist[0].t, t1 = hist[hist.length - 1].t;
        const span = Math.max(1, t1 - t0);

        // If a single cell is chosen, this trend is JUST that cell (+ average
        // for reference). Otherwise it's the whole-pack Max / Avg / Min.
        const single = selectedGraphCell !== null;
        const ci = selectedGraphCell;

        const cellVal = p => (p.cells && p.cells[ci] !== undefined) ? p.cells[ci] : null;

        // Y range.
        let ylo, yhi;
        if (single) {
            const vals = hist.map(cellVal).filter(v => v !== null).concat(hist.map(p => p.avg));
            ylo = Math.min(...vals);
            yhi = Math.max(...vals);
        } else {
            ylo = Math.min(...hist.map(p => p.min));
            yhi = Math.max(...hist.map(p => p.max));
        }

        const padY = Math.max(0.02, (yhi - ylo) * 0.15);
        ylo = Math.floor((ylo - padY) * 100) / 100;
        yhi = Math.ceil((yhi + padY) * 100) / 100;
        if (yhi - ylo < 0.02) yhi = ylo + 0.02;

        const tx = t => padL + plotW * ((t - t0) / span);
        const ty = v => padT + plotH * (1 - (v - ylo) / (yhi - ylo));

        let grid = "";
        for (let k = 0; k <= 5; k++) {
            const v = ylo + (yhi - ylo) * (k / 5);
            const y = ty(v);
            grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" class="g-grid"/>`;
            grid += `<text x="${padL - 8}" y="${(y + 4).toFixed(1)}" class="g-ylabel">${v.toFixed(2)}</text>`;
        }

        // X time labels (seconds ago).
        let xlab = "";
        for (let k = 0; k <= 4; k++) {
            const tt = t0 + span * (k / 4);
            const secsAgo = Math.round((t1 - tt) / 1000);
            xlab += `<text x="${tx(tt).toFixed(1)}" y="${(baseline + 18).toFixed(1)}" class="g-xlabel">${secsAgo === 0 ? "now" : "-" + secsAgo + "s"}</text>`;
        }

        const polyKey = (key, cls) =>
            `<path d="${smoothD(hist.map(p => [tx(p.t), ty(p[key])]))}" class="${cls}" fill="none"/>`;

        const polyCell = cls => {
            const pts = hist.filter(p => cellVal(p) !== null).map(p => [tx(p.t), ty(cellVal(p))]);
            return `<path d="${smoothD(pts)}" class="${cls}" fill="none" style="stroke:${GRAPH_GROUP_COLOR[graphCellGroup(ci, maxCell, minCell)]}"/>`;
        };

        const last = hist[hist.length - 1];
        const dotXY = (t, v, cls, style) => `<circle cx="${tx(t).toFixed(1)}" cy="${ty(v).toFixed(1)}" r="3.5" class="${cls}"${style ? ` style="${style}"` : ""}/>`;

        let series, dots, legend, subtitle;

        if (single) {

            const c = GRAPH_GROUP_COLOR[graphCellGroup(ci, maxCell, minCell)];

            series = polyKey("avg", "g-line-avg g-line-dash") + polyCell("g-line-cell");
            dots = dotXY(last.t, last.avg, "g-dot-avg") +
                   (cellVal(last) !== null ? dotXY(last.t, cellVal(last), "", `fill:${c}`) : "");

            legend =
                `<g transform="translate(${padL + 6}, ${padT + 4})">` +
                `<rect x="-4" y="-12" width="180" height="20" rx="6" fill="#ffffff" opacity="0.85"/>` +
                `<circle cx="4" cy="-2" r="4" style="fill:${c}"/><text x="12" y="2" class="g-legtext">Cell ${ci + 1}</text>` +
                `<circle cx="82" cy="-2" r="4" class="g-dot-avg"/><text x="90" y="2" class="g-legtext">Pack Avg</text>` +
                `</g>`;

        } else {

            // ALL cells, each its own line from start → now. Idle cells are
            // thin grey; the cells currently balancing stand out — discharging
            // red, charging green — so you see which cells are active among all.
            const cellPoly = (cellIdx, cls, style) => {
                const pts = hist.filter(p => p.cells && p.cells[cellIdx] !== undefined)
                    .map(p => [tx(p.t), ty(p.cells[cellIdx])]);
                return pts.length ? `<path d="${smoothD(pts)}" class="${cls}" fill="none"${style ? ` style="${style}"` : ""}/>` : "";
            };

            let idleLines = "", activeLines = "";
            for (let cellIdx = 0; cellIdx < n; cellIdx++) {
                if (cellCharging[cellIdx]) activeLines += cellPoly(cellIdx, "g-cellline active", "stroke:#22c55e");
                else if (cellBalancing[cellIdx]) activeLines += cellPoly(cellIdx, "g-cellline active", "stroke:#ef4444");
                else idleLines += cellPoly(cellIdx, "g-cellline idle");
            }

            // Idle behind, active on top, plus the pack average as a reference.
            series = idleLines + polyKey("avg", "g-line-avg g-line-dash") + activeLines;
            dots = dotXY(last.t, last.avg, "g-dot-avg");

            legend =
                `<g transform="translate(${padL + 6}, ${padT + 4})">` +
                `<rect x="-4" y="-12" width="260" height="20" rx="6" fill="#ffffff" opacity="0.85"/>` +
                `<line x1="0" y1="-2" x2="14" y2="-2" style="stroke:#94a3b8;stroke-width:2"/><text x="18" y="2" class="g-legtext">Idle cell</text>` +
                `<line x1="72" y1="-2" x2="86" y2="-2" style="stroke:#ef4444;stroke-width:2.5"/><text x="90" y="2" class="g-legtext">Discharging</text>` +
                `<line x1="164" y1="-2" x2="178" y2="-2" style="stroke:#22c55e;stroke-width:2.5"/><text x="182" y="2" class="g-legtext">Charging</text>` +
                `</g>`;

        }

        const axis = `<line x1="${padL}" y1="${baseline}" x2="${W - padR}" y2="${baseline}" class="g-axis"/>`;
        const yTitle = `<text x="16" y="${(padT + plotH / 2).toFixed(1)}" class="g-axistitle" transform="rotate(-90 16 ${(padT + plotH / 2).toFixed(1)})">Voltage (V)</text>`;
        const xTitle = `<text x="${(padL + plotW / 2).toFixed(1)}" y="${H - 8}" class="g-axistitle">${single ? "Cell " + (ci + 1) + " voltage over time" : "All cells — voltage over time"}</text>`;

        svgInner = grid + axis + series + dots + legend + xlab + yTitle + xTitle;

    }

    else if (graphView === "deviation") {

        // --- Deviation-from-average view: the core balancing outlier picture ---
        const centerY = padT + plotH / 2;
        let maxAbs = 0.005;
        for (let i = 0; i < n; i++) maxAbs = Math.max(maxAbs, Math.abs(values[i] - avgV));
        const devScale = (plotH / 2 - 10) / maxAbs;

        let grid = "";
        for (let s = -2; s <= 2; s++) {
            const dev = maxAbs * (s / 2);
            const y = centerY - dev * devScale;
            grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" class="${s === 0 ? "g-devcenter" : "g-grid"}"/>`;
            grid += `<text x="${padL - 8}" y="${(y + 4).toFixed(1)}" class="g-ylabel">${dev * 1000 >= 0 ? "+" : ""}${(dev * 1000).toFixed(0)}</text>`;
        }

        // On-chart guidance: label the centre line and the two directions.
        grid += `<text x="${(padL + 4).toFixed(1)}" y="${(centerY - 6).toFixed(1)}" class="g-devcenter-label">— Pack average (0 mV) —</text>`;
        grid += `<text x="${(W - padR - 4).toFixed(1)}" y="${(padT + 14).toFixed(1)}" class="g-devhint g-devhint-up">▲ Higher than average</text>`;
        grid += `<text x="${(W - padR - 4).toFixed(1)}" y="${(baseline - 6).toFixed(1)}" class="g-devhint g-devhint-dn">▼ Lower than average</text>`;

        // Points along the deviation line, ordered biggest outliers first.
        const pts = order.map((i, slot) => {
            const dev = values[i] - avgV;
            return { i, dev, cx: xSlot(slot), y: centerY - dev * devScale };
        });

        // Area between the line and the centre (average) line, then the line.
        const devTop = pts.map(p => [p.cx, p.y]);

        let bars = `<path d="${smoothArea(devTop, centerY)}" fill="url(#gareaGrad)" fill-rule="nonzero"/>`;
        bars += `<path d="${smoothD(devTop)}" class="g-arealine" fill="none"/>`;

        for (const p of pts) {
            const g = graphCellGroup(p.i);
            const c = GRAPH_GROUP_COLOR[g];
            const dim = graphIsDimmed(p.i, g);
            const isSel = selectedGraphCell === p.i;
            const op = dim ? 0.25 : 1;
            const r = isSel ? 6.5 : 4.5;

            bars += `<circle cx="${p.cx.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}" class="g-areadot${isSel ? " sel" : ""}" fill="${c}" opacity="${op}" style="cursor:pointer" onclick="selectGraphCell(${p.i})"><title>Cell ${p.i + 1}: ${p.dev >= 0 ? "+" : ""}${(p.dev * 1000).toFixed(0)} mV vs avg</title></circle>`;

            if (n <= 24) {
                const ly = p.dev >= 0 ? (p.y - 11) : (p.y + 17);
                bars += `<text x="${p.cx.toFixed(1)}" y="${ly.toFixed(1)}" class="g-vlabel${isSel ? " g-vlabel-sel" : ""}" opacity="${dim ? 0.35 : 1}">${p.dev >= 0 ? "+" : ""}${(p.dev * 1000).toFixed(0)}</text>`;
            }
        }

        const yTitle = `<text x="16" y="${(padT + plotH / 2).toFixed(1)}" class="g-axistitle" transform="rotate(-90 16 ${(padT + plotH / 2).toFixed(1)})">Deviation from average (mV)</text>`;
        const xTitle = `<text x="${(padL + plotW / 2).toFixed(1)}" y="${H - 8}" class="g-axistitle">Cells — biggest outliers first</text>`;

        svgInner = grid + bars + cellLabels() + yTitle + xTitle;

    } else {

        // --- Voltage bars. Warning / Critical show ONLY those cells; Normal
        // and All show every cell. ---
        let shown = order;
        if (graphHighlightGroup === "warning") shown = order.filter(i => graphCellSeverity(i) === "warning");
        else if (graphHighlightGroup === "critical") shown = order.filter(i => graphCellSeverity(i) === "critical");

        if (!shown.length) {

            svgInner = `<text x="${W / 2}" y="${H / 2}" class="g-axistitle" text-anchor="middle">No ${graphHighlightGroup} cells right now</text>`;

        } else {

            const m = shown.length;
            const xSlotL = slot => padL + (plotW / m) * (slot + 0.5);
            const slotOfL = {};
            shown.forEach((i, slot) => { slotOfL[i] = slot; });

            const shownV = shown.map(i => values[i]);
            const startV = parseFloat(document.getElementById("eqLow")?.value);
            const ovV = parseFloat(document.getElementById("ovProtection")?.value);
            const uvV = parseFloat(document.getElementById("uvProtection")?.value);

            // Include the threshold levels (avg / start / OV / UV) in the y-range
            // so every level line is actually inside the chart and shows correctly.
            const scaleVals = shownV.concat([avgV, startV, ovV, uvV].filter(v => !isNaN(v)));
            let lo = Math.floor((Math.min(...scaleVals) - 0.03) * 100) / 100;
            let hi = Math.ceil((Math.max(...scaleVals) + 0.03) * 100) / 100;
            if (lo < 0) lo = 0;
            if (hi - lo < 0.1) hi = lo + 0.1;
            const yOf = v => padT + plotH * (1 - (v - lo) / (hi - lo));

            // Zone bands behind the bars: red near OV (top), amber near UV
            // (bottom), green safe in the middle — so each bar visually lands in
            // a zone and you see which cells are creeping toward a limit.
            const warnMargin = 0.05;
            const highWarn = isNaN(ovV) ? hi : Math.max(lo, ovV - warnMargin);
            const lowWarn = isNaN(uvV) ? lo : Math.min(hi, uvV + warnMargin);
            const yHigh = yOf(highWarn), yLow = yOf(lowWarn);
            let bands = "";
            bands += `<rect x="${padL}" y="${yHigh.toFixed(1)}" width="${plotW}" height="${Math.max(0, yLow - yHigh).toFixed(1)}" fill="rgba(34,197,94,0.07)"/>`;
            if (!isNaN(ovV)) bands += `<rect x="${padL}" y="${padT}" width="${plotW}" height="${Math.max(0, yHigh - padT).toFixed(1)}" fill="rgba(248,113,113,0.14)"/>`;
            if (!isNaN(uvV)) bands += `<rect x="${padL}" y="${yLow.toFixed(1)}" width="${plotW}" height="${Math.max(0, baseline - yLow).toFixed(1)}" fill="rgba(251,191,36,0.14)"/>`;
            if (!isNaN(ovV) && yHigh - padT > 14) bands += `<text x="${(W - padR - 6).toFixed(1)}" y="${(padT + 13).toFixed(1)}" text-anchor="end" style="fill:#f87171;font-size:10px;font-weight:700;opacity:.85">near OV</text>`;
            if (!isNaN(uvV) && baseline - yLow > 14) bands += `<text x="${(W - padR - 6).toFixed(1)}" y="${(baseline - 6).toFixed(1)}" text-anchor="end" style="fill:#fbbf24;font-size:10px;font-weight:700;opacity:.85">near UV</text>`;

            let grid = "";
            for (let t = 0; t <= 5; t++) {
                const v = lo + (hi - lo) * (t / 5);
                const y = yOf(v);
                grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" class="g-grid"/>`;
                grid += `<text x="${padL - 8}" y="${(y + 4).toFixed(1)}" class="g-ylabel">${v.toFixed(3)}</text>`;
            }

            // Bright, clearly-labelled level lines — each label in a dark pill
            // so it stays readable over the bars. avg=blue, start=grey,
            // OV=red, UV=amber.
            const refLine = graphRefLine(lo, hi, yOf, padL, padR, W);
            let refs = "";
            refs += refLine(avgV, "#60a5fa", "avg " + avgV.toFixed(3), "right");
            refs += refLine(startV, "#cbd5e1", "start " + (isNaN(startV) ? "" : startV.toFixed(3)), "left");
            refs += refLine(ovV, "#f87171", "OV " + (isNaN(ovV) ? "" : ovV.toFixed(3)), "right");
            refs += refLine(uvV, "#fbbf24", "UV " + (isNaN(uvV) ? "" : uvV.toFixed(3)), "left");

            const slotW = plotW / m;
            const barW = Math.min(48, slotW * 0.62);

            // Colour each bar by its voltage LEVEL (green normal, yellow high,
            // red very-high, blue low) — matching the cells and the reference.
            // BUT in the Warning / Critical filtered views, colour by SEVERITY
            // instead (amber = warning, red = critical) so an out-of-balance
            // cell never looks "Normal" green — every visible bar reads as the
            // fault it was filtered for.
            const LEVEL_COLOR = { normal: "#22c55e", high: "#f5c518", veryhigh: "#ef4444", low: "#3b82f6" };
            const sevView = graphHighlightGroup === "warning" || graphHighlightGroup === "critical";
            const SEV_COLOR = { warning: "#f59e0b", critical: "#dc2626" };

            let bars = "";
            shown.forEach((i, slot) => {
                const cx = xSlotL(slot);
                const y = yOf(values[i]);
                const lvl = cellLevel(i);
                const c = sevView ? SEV_COLOR[graphHighlightGroup] : LEVEL_COLOR[lvl];
                const isSel = selectedGraphCell === i;
                const h = Math.max(1, baseline - y);
                const x = cx - barW / 2;

                const grow = graphAnimate
                    ? `<animate attributeName="height" from="0" to="${h.toFixed(1)}" dur="0.7s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.25 1 0.5 1"/><animate attributeName="y" from="${baseline.toFixed(1)}" to="${y.toFixed(1)}" dur="0.7s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.25 1 0.5 1"/>`
                    : "";

                bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="4" ry="4" class="g-bar${isSel ? " sel" : ""}" fill="${c}" style="cursor:pointer" onclick="selectGraphCell(${i})"><title>Cell ${i + 1}: ${values[i].toFixed(3)} V</title>${grow}</rect>`;

                if (m <= 24)
                    bars += `<text x="${cx.toFixed(1)}" y="${(y - 10).toFixed(1)}" class="g-vlabel${isSel ? " g-vlabel-sel" : ""}">${values[i].toFixed(3)}</text>`;

                bars += `<text x="${cx.toFixed(1)}" y="${(baseline + 24).toFixed(1)}" class="g-xlabel${isSel ? " g-xlabel-sel" : ""}">${i + 1}</text>`;
            });

            const axis = `<line x1="${padL}" y1="${baseline}" x2="${W - padR}" y2="${baseline}" class="g-axis"/>` +
                `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${baseline}" class="g-axis"/>`;

            // Balancing flow arrow (only in the full / normal view).
            let flow = "";
            if (!graphHighlightGroup || graphHighlightGroup === "normal") {
                const dis = balancingCellIndices();
                const recv = chargingCellIndex(dis);
                if (dis.length && recv >= 0 && slotOfL[dis[0]] !== undefined && slotOfL[recv] !== undefined) {
                    const sx = xSlotL(slotOfL[dis[0]]);
                    const rx = xSlotL(slotOfL[recv]);
                    const sy = yOf(values[dis[0]]) - 12;
                    const ry = yOf(values[recv]) - 12;
                    const topY = Math.min(sy, ry) - 26;
                    flow = `<path d="M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${((sx + rx) / 2).toFixed(1)} ${topY.toFixed(1)} ${rx.toFixed(1)} ${ry.toFixed(1)}" class="g-flowline" marker-end="url(#gflow)"/>`;
                }
            }

            // Colour legend — voltage level (matches the cells). Vertical, on
            // the RIGHT side of the graph.
            const lgItem = (yy, col, label) =>
                `<rect x="0" y="${yy}" width="13" height="13" rx="3" fill="${col}"/>` +
                `<text x="19" y="${yy + 11}" class="g-legtext">${label}</text>`;
            let legend;
            if (sevView) {
                // Only the filtered fault class is on screen — one matching key.
                const col = SEV_COLOR[graphHighlightGroup];
                const lab = graphHighlightGroup === "warning" ? "Warning" : "Critical";
                legend =
                    `<g transform="translate(${W - padR + 34}, ${(padT + plotH / 2 - 6).toFixed(1)})">` +
                    lgItem(0, col, lab) +
                    `</g>`;
            } else {
                legend =
                    `<g transform="translate(${W - padR + 44}, ${(padT + plotH / 2 - 44).toFixed(1)})">` +
                    lgItem(0, "#22c55e", "Normal") +
                    lgItem(24, "#f5c518", "High") +
                    lgItem(48, "#ef4444", "Very High") +
                    lgItem(72, "#3b82f6", "Low") +
                    `</g>`;
            }

            const titleTxt = graphHighlightGroup === "warning" ? "⚠ Warning cells only"
                : graphHighlightGroup === "critical" ? "⛔ Critical cells only"
                : "Cell Number" + (graphView === "sorted" ? " (high → low)" : "");

            const yTitle = `<text x="16" y="${(padT + plotH / 2).toFixed(1)}" class="g-axistitle" transform="rotate(-90 16 ${(padT + plotH / 2).toFixed(1)})">Voltage (V)</text>`;
            const xTitle = `<text x="${(padL + plotW / 2).toFixed(1)}" y="${H - 8}" class="g-axistitle">${titleTxt}</text>`;

            svgInner = grid + axis + bars + flow + legend + yTitle + xTitle;

        }

    }

    body.innerHTML =
        `<svg viewBox="0 0 ${W} ${H}" class="graph-svg" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Cell voltage chart">` +
        defs + svgInner +
        `</svg>`;

    // Entrance animations play once; the next live refresh is a quiet update.
    graphAnimate = false;

    // ---- Balancing progress bar (spread closing toward balanced) ----
    const balEl = document.getElementById("graphBalProgress");

    if (balEl) {

        if (balancingActive && balanceStartSpread && balanceStartSpread > BALANCED_DIFF_V) {

            const curSpread = maxV - minV;
            const prog = Math.max(0, Math.min(1,
                (balanceStartSpread - curSpread) / (balanceStartSpread - BALANCED_DIFF_V)));
            const clock = balanceCompletionClock();

            balEl.style.display = "flex";
            balEl.innerHTML =
                `<span class="gbp-label">⚖ Balancing · spread ${curSpread.toFixed(3)} V${clock ? ` · completes ${clock}` : ""}</span>` +
                `<span class="gbp-track"><span class="gbp-fill" style="width:${(prog * 100).toFixed(0)}%"></span></span>` +
                `<span class="gbp-pct">${(prog * 100).toFixed(0)}%</span>`;

        } else {

            balEl.style.display = "none";
            balEl.innerHTML = "";

        }

    }

    // ---- Detail panel for the clicked cell ----
    if (detailEl) renderGraphDetail(detailEl, values, avgV, maxCell, minCell);

}

// The panel under the chart: everything about the clicked cell.
function renderGraphDetail(detailEl, values, avgV, maxCell, minCell) {

    if (selectedGraphCell === null) {

        detailEl.innerHTML = `<span class="gd-hint">Tip: click a bar to see that cell's details</span>`;

        return;

    }

    const i = selectedGraphCell;
    const v = values[i];
    const g = graphCellGroup(i, maxCell, minCell);

    // State tags (a cell can be several at once, e.g. Highest + Discharging).
    const tags = [];

    if (cellOVFault[i]) tags.push(`<span class="gd-tag gd-fault">Over-Voltage</span>`);
    if (cellUVFault[i]) tags.push(`<span class="gd-tag gd-fault">Under-Voltage</span>`);
    if (cellBalancing[i]) tags.push(`<span class="gd-tag" style="--gc:#d97706">Discharging</span>`);
    if (cellCharging[i]) tags.push(`<span class="gd-tag" style="--gc:#0d9488">Charging</span>`);
    if (i === maxCell) tags.push(`<span class="gd-tag" style="--gc:#ef4444">Highest</span>`);
    if (i === minCell) tags.push(`<span class="gd-tag" style="--gc:#10b981">Lowest</span>`);
    if (!tags.length) tags.push(`<span class="gd-tag" style="--gc:#2563eb">Normal</span>`);

    // Balancing partner, if this cell is part of a transfer.
    const dis = balancingCellIndices();
    const recv = chargingCellIndex(dis);

    let partner = "";

    if (cellBalancing[i]) {
        partner = recv >= 0
            ? `<div class="gd-row"><span>Transfer</span><b>Cell ${i + 1} → Cell ${recv + 1}</b></div>`
            : `<div class="gd-row"><span>Transfer</span><b>Dissipating</b></div>`;
    }
    else if (cellCharging[i] && dis.length) {
        partner = `<div class="gd-row"><span>Transfer</span><b>Cell ${dis[0] + 1} → Cell ${i + 1}</b></div>`;
    }

    const diff = v - avgV;

    detailEl.innerHTML = `
        <div class="gd-head">
            <span class="gd-cellchip" style="--gc:${GRAPH_GROUP_COLOR[g]}">Cell ${i + 1}</span>
            ${tags.join(" ")}
            <button class="gd-clear" onclick="selectGraphCell(${i})">✕</button>
        </div>
        <div class="gd-grid">
            <div class="gd-row"><span>Voltage</span><b>${v.toFixed(3)} V</b></div>
            <div class="gd-row"><span>vs Average</span><b>${diff >= 0 ? "+" : ""}${diff.toFixed(3)} V</b></div>
            <div class="gd-row"><span>Discharged</span><b>▼ ${cellDischargeCount[i]}</b></div>
            <div class="gd-row"><span>Charged</span><b>▲ ${cellChargeCount[i]}</b></div>
            ${partner}
        </div>`;

}
