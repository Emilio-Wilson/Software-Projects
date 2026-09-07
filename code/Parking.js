/**
 * SignalR Module - Airport_Parking_Status_Fake_Demo
 * Real-time terminal equipment + facility capacity push from /hubs/Airport_Parking_Status_Fake_Demo
 *
 * ------------------------------------------------------
 * THE ONLY LIVE FEED
 * ------------------------------------------------------
 *   /hubs/Airport_Parking_Status_Fake_Demo  -> ReceiveAirport_Parking_Status_Fake_Demo
 *   fallback: GET /api/Airport_Parking_Status_Fake_Demo
 *   consumed by: src/sign-main.js
 *
 * Both the hub URLs and the HTTP URLs come from resilience.primary /
 * resilience.failover, tried in that order.
 *
 * A second module used to sit alongside this one, feeding a lot-by-lot
 * listing off /hubs/parking. That view and its whole data layer are gone,
 * and config.json has no endpoints.parking, so this is now the single
 * source of data for the display.
 *
 * ------------------------------------------------------
 * RESILIENCE MODEL (retry-forever)
 * ------------------------------------------------------
 * Designed for 24/7 unattended signs. SignalR push is
 * the primary data path; HTTP polling against /api/Airport_Parking_Status_Fake_Demo
 * is a fallback that only runs during long outages. SignalR
 * retries FOREVER - the connection is never given up on.
 *
 * Retry schedule (used by BOTH the initial-connect and
 * reconnect-after-drop paths):
 *   Attempts 1-5 (first ~47s):  0ms, 2s, 5s, 10s, 30s
 *      SignalR-only. No HTTP polling.
 *   Attempts 6+ (long outage):  30s forever
 *      Keep retrying SignalR AND start 30s HTTP polling
 *      so the display stays fresh until SignalR recovers.
 *
 * On any successful (re)connect:
 *   - Stop fallback polling
 *   - Re-invoke JoinAirport_Parking_Status_Fake_Demo (group membership doesn't
 *     survive a connection swap on the server)
 *   - Do one HTTP fetch to catch up immediately
 *
 * ------------------------------------------------------
 * PUBLIC API
 * ------------------------------------------------------
 *   connectAirport_Parking_Status_Fake_Demo(callback)  Connect once and wire pushes
 *                                    to `callback(rows)`. Returns
 *                                    nothing - connection runs in
 *                                    the background and never
 *                                    gives up.
 *   isAirport_Parking_Status_Fake_DemoConnected()      true while WebSocket is up
 *   isAirport_Parking_Status_Fake_DemoFallbackActive() true while 30s HTTP poll is
 *                                    armed (long-outage mode)
 *   getAirport_Parking_Status_Fake_DemoDiagnostics()   inspection object for debug
 *   stopAirport_Parking_Status_Fake_Demo()             permanent shutdown (cleanup)
 */

import {
    isLocalhost,
    isResilienceEnabled,
    getResilienceEndpoints,
    getAirport_Parking_Status_Fake_DemoEndpoint
} from './config.js';
import { logError } from './logger.js';

// -- Tunables (match signalr.js) -------------------------
const RETRY_SCHEDULE = [0, 2000, 5000, 10000, 30000];
const LONG_OUTAGE_DELAY = 30000;
const FALLBACK_INTERVAL = 30000;

// -- State (module-private) ------------------------------
let connection = null;
let signalRConnected = false;
let activeHubUrl = null;
let onRowsReceived = null;

let initialConnectAttempt = 0;
let pendingConnectTimer = null;
let connectLoopActive = false;     // true while attemptInitialConnect is executing
let reconnectingCount = 0;

let fallbackTimer = null;
let stopRequested = false;

/**
 * Derive the hub URL(s) for /hubs/Airport_Parking_Status_Fake_Demo.
 *
 * Both modes now start from the Airport_Parking_Status_Fake_Demo endpoint itself, not from
 * the parking endpoint - the two feeds are configured separately in
 * config.json, so there is nothing to swap.
 */
function getHubUrls() {
    return getFeedUrls('/hubs/Airport_Parking_Status_Fake_Demo', 'Airport_Parking_Status_Fake_Demo hub');
}

/**
 * Derive the HTTP URL(s) for the catch-up fetch and the long-outage
 * polling. Same resolution as getHubUrls(), different path.
 */
function getHttpUrls() {
    return getFeedUrls('/api/Airport_Parking_Status_Fake_Demo', 'Airport_Parking_Status_Fake_Demo HTTP');
}

/**
 * Shared resolution for both of the above.
 *
 * In resilience mode the configured primary/failover pair is used in
 * order. Otherwise the single configured Airport_Parking_Status_Fake_Demo endpoint is used.
 * On localhost, demo mode - no URLs at all.
 *
 * @param {string} path  '/hubs/Airport_Parking_Status_Fake_Demo' or '/api/Airport_Parking_Status_Fake_Demo'
 * @param {string} label for log lines
 * @returns {string[]} URLs in priority order
 */
function getFeedUrls(path, label) {
    if (isLocalhost()) return [];

    const swapPath = (u) => {
        try {
            const url = new URL(u);
            return `${url.protocol}//${url.host}${path}`;
        } catch (e) {
            console.warn(`${label}: could not parse endpoint URL`, u);
            return null;
        }
    };

    if (isResilienceEnabled()) {
        const endpoints = getResilienceEndpoints();
        if (!endpoints?.primary) {
            console.warn(`${label}: resilience mode but no primary endpoint configured`);
            return [];
        }
        const urls = [endpoints.primary, endpoints.failover]
            .filter(Boolean)
            .map(swapPath)
            .filter(Boolean);
        // Dedupe: if primary and failover resolve to the same host, don't
        // attempt the same URL twice per retry round.
        return [...new Set(urls)];
    }

    const endpoint = getAirport_Parking_Status_Fake_DemoEndpoint();
    if (!endpoint) return [];
    const one = swapPath(endpoint);
    return one ? [one] : [];
}

/**
 * Connect to the terminal-status hub and start receiving pushes.
 * Idempotent - calling twice is a no-op.
 *
 * @param {Function} callback - receives the rows array on each push
 */
export function connectAirport_Parking_Status_Fake_Demo(callback) {
    if (connection || pendingConnectTimer || connectLoopActive) {
        console.warn('Airport_Parking_Status_Fake_Demo: connectAirport_Parking_Status_Fake_Demo called twice, ignoring');
        return;
    }

    onRowsReceived = callback;
    stopRequested = false;
    initialConnectAttempt = 0;

    const hubUrls = getHubUrls();
    if (hubUrls.length === 0) {
        console.log('[demo] Airport_Parking_Status_Fake_Demo: no hub URLs (localhost/demo) - disabled');
        return;
    }

    if (typeof signalR === 'undefined') {
        console.error('[fail] Airport_Parking_Status_Fake_Demo: SignalR library not loaded - falling back to HTTP polling only');
        startFallbackPoll();
        return;
    }

    attemptInitialConnect();
}

async function attemptInitialConnect() {
    if (stopRequested) { connectLoopActive = false; return; }
    connectLoopActive = true;
    pendingConnectTimer = null;

    const hubUrls = getHubUrls();
    let lastError = null;

    for (const hubUrl of hubUrls) {
        if (stopRequested) { connectLoopActive = false; return; }

        try {
            await tryConnect(hubUrl);
            initialConnectAttempt = 0;
            stopFallbackPoll();
            connectLoopActive = false;
            return;
        } catch (err) {
            lastError = err;
            console.warn(`[fail] Airport_Parking_Status_Fake_Demo: connect failed for ${hubUrl}: ${err?.message || err}`);
        }
    }

    const attemptNum = initialConnectAttempt;
    const delay = attemptNum < RETRY_SCHEDULE.length
        ? RETRY_SCHEDULE[attemptNum]
        : LONG_OUTAGE_DELAY;
    initialConnectAttempt++;

    console.warn(
        `[net] Airport_Parking_Status_Fake_Demo: initial connect attempt ${initialConnectAttempt} failed ` +
        `(${lastError?.message || 'unknown error'}). Retrying in ${delay}ms...`
    );

    if (initialConnectAttempt > RETRY_SCHEDULE.length) {
        startFallbackPoll();
    }

    pendingConnectTimer = setTimeout(attemptInitialConnect, delay);
}

async function tryConnect(hubUrl) {
    // Mark the stop as intentional so its onclose handler doesn't
    // treat it as a failure (start polling / spawn another loop).
    if (connection) {
        connection._intentionalStop = true;
        try { await connection.stop(); } catch (_) { }
        connection = null;
    }

    const retryPolicy = {
        nextRetryDelayInMilliseconds: (retryContext) => {
            const attempt = retryContext.previousRetryCount;
            if (attempt >= RETRY_SCHEDULE.length) {
                startFallbackPoll();
                return LONG_OUTAGE_DELAY;
            }
            return RETRY_SCHEDULE[attempt];
        }
    };

    const conn = new signalR.HubConnectionBuilder()
        .withUrl(hubUrl)
        .withAutomaticReconnect(retryPolicy)
        .configureLogging(signalR.LogLevel.Warning)
        .build();

    // -- Receive terminal-status push ----------------------
    conn.on('ReceiveAirport_Parking_Status_Fake_Demo', (rows) => {
        console.log(`[net] Airport_Parking_Status_Fake_Demo: received ${rows?.length || 0} terminal rows`);
        reconnectingCount = 0;
        stopFallbackPoll();
        if (onRowsReceived && rows) {
            onRowsReceived(rows);
        }
    });

    conn.onreconnecting((error) => {
        signalRConnected = false;
        reconnectingCount++;
        console.warn(
            `[retry] Airport_Parking_Status_Fake_Demo: reconnecting (attempt ${reconnectingCount})`,
            error?.message || ''
        );
    });

    conn.onreconnected(async (connectionId) => {
        signalRConnected = true;
        reconnectingCount = 0;
        stopFallbackPoll();
        console.log(`[ok] Airport_Parking_Status_Fake_Demo: reconnected (${connectionId})`);

        try {
            await conn.invoke('JoinAirport_Parking_Status_Fake_Demo');
            console.log('[ok] Airport_Parking_Status_Fake_Demo: re-joined Airport_Parking_Status_Fake_Demo group');
        } catch (err) {
            console.error('[fail] Airport_Parking_Status_Fake_Demo: failed to re-join group:', err.message);
        }

        try {
            const data = await fetchAirport_Parking_Status_Fake_Demo();
            if (data && onRowsReceived) onRowsReceived(data);
        } catch (_) { /* fetchAirport_Parking_Status_Fake_Demo logs its own errors */ }
    });

    conn.onclose((error) => {
        signalRConnected = false;

        // Deliberate internal stop (teardown or join-failure cleanup)
        // - not an outage. Don't poll, don't restart anything.
        if (conn._intentionalStop || stopRequested) return;

        console.error('[fail] Airport_Parking_Status_Fake_Demo: connection closed', error?.message || 'unknown');

        startFallbackPoll();

        // If a connect loop is already executing or scheduled,
        // let it finish - starting a second concurrent loop here
        // is how orphaned duplicate connections get created.
        if (connectLoopActive || pendingConnectTimer) {
            console.log('Airport_Parking_Status_Fake_Demo: rebuild already in progress, not starting another');
            return;
        }

        initialConnectAttempt = 0;
        attemptInitialConnect();
    });

    await conn.start();
    console.log(`[ok] Airport_Parking_Status_Fake_Demo: connected to ${hubUrl}`);

    // If the join fails, the WebSocket is OPEN but the conn was
    // never committed to `connection` - without an explicit stop()
    // here it would leak as a live, auto-reconnecting zombie that
    // no cleanup path can ever reach.
    try {
        await conn.invoke('JoinAirport_Parking_Status_Fake_Demo');
    } catch (err) {
        conn._intentionalStop = true;
        try { await conn.stop(); } catch (_) { }
        throw err;
    }
    console.log('[ok] Airport_Parking_Status_Fake_Demo: joined Airport_Parking_Status_Fake_Demo group');

    connection = conn;
    signalRConnected = true;
    activeHubUrl = hubUrl;

    try {
        const data = await fetchAirport_Parking_Status_Fake_Demo();
        if (data && onRowsReceived) onRowsReceived(data);
    } catch (_) { /* fetchAirport_Parking_Status_Fake_Demo logs its own errors */ }
}

/* ----------------------------------------------------------
   HTTP-ONLY MODE
   No SignalR at all - GET /api/Airport_Parking_Status_Fake_Demo on an interval.
   Selected by `source=http` in ViewTypeSettings.txt.
   ---------------------------------------------------------- */

// Tighter than FALLBACK_INTERVAL because here polling is the only data
// path, not a stopgap.
const HTTP_ONLY_INTERVAL = 15000;

let httpOnlyMode = false;
let httpOnlyTimer = null;
let httpOnlyInterval = HTTP_ONLY_INTERVAL;

/**
 * Start HTTP-only polling of /api/Airport_Parking_Status_Fake_Demo. Fetches immediately, then
 * every `intervalMs`. Never gives up: a failed poll logs and the next one is
 * still scheduled.
 *
 * @param {Function} callback - receives the rows array on each success
 * @param {number} [intervalMs=15000]
 */
export function startAirport_Parking_Status_Fake_DemoPolling(callback, intervalMs = HTTP_ONLY_INTERVAL) {
    if (connection || pendingConnectTimer || connectLoopActive) {
        console.warn('Airport_Parking_Status_Fake_Demo: SignalR mode is running, ignoring startAirport_Parking_Status_Fake_DemoPolling');
        return;
    }
    if (httpOnlyMode) {
        console.warn('Airport_Parking_Status_Fake_Demo: HTTP-only polling already started, ignoring');
        return;
    }

    const urls = getHttpUrls();
    if (urls.length === 0) {
        console.log('[demo] Airport_Parking_Status_Fake_Demo: no HTTP URLs (localhost/demo) - polling disabled');
        return;
    }

    onRowsReceived = callback;
    stopRequested = false;
    httpOnlyMode = true;
    httpOnlyInterval = Number(intervalMs) > 0 ? Number(intervalMs) : HTTP_ONLY_INTERVAL;

    console.log(`[net] Airport_Parking_Status_Fake_Demo: HTTP-only polling every ${httpOnlyInterval}ms -> ${urls[0]}`);
    httpOnlyPoll();
}

async function httpOnlyPoll() {
    if (stopRequested || !httpOnlyMode) { httpOnlyTimer = null; return; }

    try {
        const data = await fetchAirport_Parking_Status_Fake_Demo();
        if (data && onRowsReceived) onRowsReceived(data);
    } catch (err) {
        logError(`Airport_Parking_Status_Fake_Demo HTTP-only poll failed: ${err?.message || err}`);
    }

    if (!stopRequested && httpOnlyMode) {
        httpOnlyTimer = setTimeout(httpOnlyPoll, httpOnlyInterval);
    } else {
        httpOnlyTimer = null;
    }
}

/** Stop HTTP-only polling. Safe to call when it isn't running. */
export function stopAirport_Parking_Status_Fake_DemoPolling() {
    httpOnlyMode = false;
    if (httpOnlyTimer) {
        clearTimeout(httpOnlyTimer);
        httpOnlyTimer = null;
        console.log('[net] Airport_Parking_Status_Fake_Demo: HTTP-only polling stopped');
    }
}

/* ----------------------------------------------------------
   FALLBACK HTTP POLLING
   Activates when SignalR is in a long outage. Tries primary
   then failover within each poll attempt.
   ---------------------------------------------------------- */

function startFallbackPoll() {
    if (fallbackTimer) return;
    if (stopRequested) return;
    if (httpOnlyMode) return;   // already polling on purpose
    console.log('[net] Airport_Parking_Status_Fake_Demo: starting fallback HTTP poll (30s)');
    fallbackPoll();
}

function stopFallbackPoll() {
    if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
        console.log('[net] Airport_Parking_Status_Fake_Demo: fallback HTTP poll stopped');
    }
}

async function fallbackPoll() {
    if (stopRequested) { fallbackTimer = null; return; }
    if (signalRConnected) { fallbackTimer = null; return; }

    try {
        const data = await fetchAirport_Parking_Status_Fake_Demo();
        if (data && onRowsReceived) onRowsReceived(data);
    } catch (err) {
        logError(`Airport_Parking_Status_Fake_Demo fallback poll failed: ${err?.message || err}`);
    }

    if (!stopRequested && !signalRConnected) {
        fallbackTimer = setTimeout(fallbackPoll, FALLBACK_INTERVAL);
    } else {
        fallbackTimer = null;
    }
}

/**
 * HTTP fetch of /api/Airport_Parking_Status_Fake_Demo. Tries primary then failover
 * (when resilience is enabled). Used by:
 *   - initial catch-up after successful connect
 *   - reconnect catch-up
 *   - fallback polling during long outages
 *
 * Kept inline in this module so the sign has exactly one data layer and
 * no shared fetch helper to keep in step with it.
 *
 * @returns {Promise<Array|null>} rows array, or null on failure
 */
async function fetchAirport_Parking_Status_Fake_Demo() {
    const urls = getHttpUrls();
    if (urls.length === 0) return null;

    let lastError = null;
    for (const url of urls) {
        try {
            const response = await fetch(url, { cache: 'no-store' });
            if (!response.ok) {
                lastError = new Error(`HTTP ${response.status}`);
                continue;
            }
            const data = await response.json();
            return Array.isArray(data) ? data : null;
        } catch (err) {
            lastError = err;
        }
    }

    logError(`fetchAirport_Parking_Status_Fake_Demo: all URLs failed (${lastError?.message || 'unknown'})`);
    return null;
}

/* ----------------------------------------------------------
   STATUS & CLEANUP
   ---------------------------------------------------------- */

export function isAirport_Parking_Status_Fake_DemoConnected() {
    return signalRConnected
        && connection
        && connection.state === signalR.HubConnectionState.Connected;
}

export function isAirport_Parking_Status_Fake_DemoFallbackActive() {
    return fallbackTimer !== null;
}

export async function stopAirport_Parking_Status_Fake_Demo() {
    stopRequested = true;
    stopFallbackPoll();
    stopAirport_Parking_Status_Fake_DemoPolling();

    if (pendingConnectTimer) {
        clearTimeout(pendingConnectTimer);
        pendingConnectTimer = null;
    }
    // Any in-flight attemptInitialConnect will exit at its next
    // stopRequested checkpoint; clear the flag so a future
    // connectAirport_Parking_Status_Fake_Demo() isn't blocked forever.
    connectLoopActive = false;

    if (connection) {
        connection._intentionalStop = true;
        try {
            await connection.stop();
            console.log('Airport_Parking_Status_Fake_Demo: connection stopped');
        } catch (err) {
            console.warn('Airport_Parking_Status_Fake_Demo: stop error', err.message);
        }
        connection = null;
        signalRConnected = false;
    }
}

export function getAirport_Parking_Status_Fake_DemoDiagnostics() {
    return {
        mode: httpOnlyMode ? 'http-only' : 'signalr',
        connected: signalRConnected,
        state: connection ? connection.state : 'none',
        activeHubUrl,
        hubUrls: getHubUrls(),
        httpUrls: getHttpUrls(),
        initialConnectAttempt,
        connectLoopActive,
        reconnectingCount,
        fallbackActive: fallbackTimer !== null,
        httpOnlyActive: httpOnlyTimer !== null,
        httpOnlyInterval,
        stopRequested
    };
}