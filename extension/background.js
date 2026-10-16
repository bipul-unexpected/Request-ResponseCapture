// File: brave-nettap/extension/background.js
// Runtime: Brave / Chromium Manifest V3 Service Worker

const sessions = new Map(); // tabId -> SessionState

function createSessionState(tabId, tabUrl) {
  return {
    tabId,
    targetUrl: tabUrl,
    startedAt: new Date().toISOString(),
    startedEpochMs: Date.now(),
    requests: new Map(),
    websockets: new Map(),
    detachReason: null
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.cmd === "START_CAPTURE") {
        sendResponse(await startCapture(msg.tabId, msg.tabUrl));
      } else if (msg.cmd === "EXPORT_LIVE") {
        sendResponse(await exportCurrentSession(msg.tabId, false));
      } else if (msg.cmd === "STOP_AND_EXPORT") {
        sendResponse(await exportCurrentSession(msg.tabId, true));
      } else if (msg.cmd === "GET_STATUS") {
        const state = sessions.get(msg.tabId);
        sendResponse({
          ok: true,
          recording: Boolean(state),
          requestCount: state ? state.requests.size : 0,
          wsCount: state ? state.websockets.size : 0,
          startedAt: state ? state.startedAt : null
        });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();
  return true;
});

async function startCapture(tabId, tabUrl) {
  if (sessions.has(tabId)) {
    return { ok: true, status: "already_recording" };
  }

  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  await chrome.debugger.sendCommand(target, "Network.enable", {
    maxTotalBufferSize: 100 * 1024 * 1024,    // 100 MB total buffer
    maxResourceBufferSize: 25 * 1024 * 1024,  // 25 MB per resource
    maxPostDataSize: 10 * 1024 * 1024         // 10 MB POST payload capture
  });

  sessions.set(tabId, createSessionState(tabId, tabUrl));
  return { ok: true, status: "recording_started" };
}

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  const state = sessions.get(source.tabId);
  if (!state) return;

  const reqMap = state.requests;
  const wsMap = state.websockets;

  switch (method) {
    case "Network.requestWillBeSent": {
      const { requestId, request, wallTime, timestamp, initiator, type, documentURL } = params;
      const entry = reqMap.get(requestId) || { requestId, redirects: [] };

      if (params.redirectResponse) {
        entry.redirects.push({
          url: entry.url,
          status: params.redirectResponse.status,
          statusText: params.redirectResponse.statusText,
          headers: params.redirectResponse.headers
        });
      }

      entry.url = request.url;
      entry.method = request.method;
      entry.resourceType = type || "Other";
      entry.documentURL = documentURL || null;
      entry.requestHeaders = request.headers || {};
      entry.hasPostData = Boolean(request.hasPostData);
      entry.postData = request.postData || null;
      entry.postDataParsedJson = tryParseJson(request.postData);
      entry.initiator = {
        type: initiator?.type || "unknown",
        url: initiator?.url || null,
        lineNumber: initiator?.lineNumber ?? null
      };
      entry.wallTimeIso = wallTime ? new Date(wallTime * 1000).toISOString() : new Date().toISOString();
      entry.startMonotonicSec = timestamp;
      entry.status = null;
      entry.statusText = null;
      entry.mimeType = null;
      entry.protocol = null;
      entry.remoteIPAddress = null;
      entry.remotePort = null;
      entry.fromDiskCache = false;
      entry.fromServiceWorker = false;
      entry.responseHeaders = {};
      entry.timing = null;
      entry.encodedDataLength = 0;
      entry.durationMs = null;
      entry.responseBody = null;
      entry.responseBodyBase64 = false;
      entry.responseBodyParsedJson = null;
      entry.errorText = null;
      entry.canceled = false;

      reqMap.set(requestId, entry);
      break;
    }

    case "Network.requestWillBeSentExtraInfo": {
      const entry = reqMap.get(params.requestId);
      if (entry) {
        entry.rawRequestHeadersExtra = params.headers || {};
        entry.associatedCookies = params.associatedCookies || [];
      }
      break;
    }

    case "Network.responseReceived": {
      const { requestId, response, type } = params;
      const entry = reqMap.get(requestId);
      if (!entry) break;

      entry.resourceType = type || entry.resourceType;
      entry.status = response.status;
      entry.statusText = response.statusText;
      entry.mimeType = response.mimeType;
      entry.protocol = response.protocol;
      entry.remoteIPAddress = response.remoteIPAddress || null;
      entry.remotePort = response.remotePort || null;
      entry.fromDiskCache = Boolean(response.fromDiskCache);
      entry.fromServiceWorker = Boolean(response.fromServiceWorker);
      entry.responseHeaders = response.headers || {};
      entry.timing = response.timing || null;
      break;
    }

    case "Network.responseReceivedExtraInfo": {
      const entry = reqMap.get(params.requestId);
      if (entry) {
        entry.rawResponseHeadersExtra = params.headers || {};
        entry.statusCodeExtra = params.statusCode;
      }
      break;
    }

    case "Network.loadingFinished": {
      const { requestId, timestamp, encodedDataLength } = params;
      const entry = reqMap.get(requestId);
      if (!entry) break;

      entry.encodedDataLength = encodedDataLength || 0;
      if (typeof entry.startMonotonicSec === "number" && typeof timestamp === "number") {
        entry.durationMs = Number(((timestamp - entry.startMonotonicSec) * 1000).toFixed(2));
      }

      try {
        const bodyRes = await chrome.debugger.sendCommand(
          { tabId: source.tabId },
          "Network.getResponseBody",
          { requestId }
        );
        if (bodyRes) {
          entry.responseBody = bodyRes.body;
          entry.responseBodyBase64 = Boolean(bodyRes.base64Encoded);
          if (!bodyRes.base64Encoded && bodyRes.body) {
            entry.responseBodyParsedJson = tryParseJson(bodyRes.body);
          }
        }
      } catch (bodyErr) {
        entry.responseBodyNote = String(bodyErr?.message || "No body buffered (redirect, 204, or preflight)");
      }
      break;
    }

    case "Network.loadingFailed": {
      const { requestId, timestamp, errorText, canceled, blockedReason } = params;
      const entry = reqMap.get(requestId);
      if (!entry) break;

      if (typeof entry.startMonotonicSec === "number" && typeof timestamp === "number") {
        entry.durationMs = Number(((timestamp - entry.startMonotonicSec) * 1000).toFixed(2));
      }
      entry.errorText = errorText || "Failed";
      entry.canceled = Boolean(canceled);
      entry.blockedReason = blockedReason || null;
      break;
    }

    case "Network.webSocketCreated": {
      wsMap.set(params.requestId, {
        requestId: params.requestId,
        url: params.url,
        initiator: params.initiator || null,
        createdAtIso: new Date().toISOString(),
        frames: []
      });
      break;
    }

    case "Network.webSocketFrameSent":
    case "Network.webSocketFrameReceived": {
      const ws = wsMap.get(params.requestId);
      if (ws && ws.frames.length < 5000) {
        ws.frames.push({
          direction: method.endsWith("Sent") ? "SENT" : "RECEIVED",
          timestamp: params.timestamp,
          opcode: params.response?.opcode,
          payloadData: params.response?.payloadData,
          payloadJson: tryParseJson(params.response?.payloadData)
        });
      }
      break;
    }
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const state = sessions.get(source.tabId);
  if (state) state.detachReason = reason;
});

function tryParseJson(str) {
  if (typeof str !== "string" || !str) return null;
  const trimmed = str.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return JSON.parse(trimmed);
    } catch (_) {
      return null;
    }
  }
  return null;
}

function computeAnalytics(state) {
  const entries = Array.from(state.requests.values());
  const wsEntries = Array.from(state.websockets.values());

  let totalBytes = 0;
  let failedCount = 0;
  let cachedCount = 0;
  const durations = [];
  const byStatusBucket = { "1xx": 0, "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, "failed_or_pending": 0 };
  const byMethod = {};
  const byResourceType = {};
  const byDomain = {};

  for (const r of entries) {
    totalBytes += r.encodedDataLength || 0;
    if (r.errorText) failedCount++;
    if (r.fromDiskCache || r.fromServiceWorker) cachedCount++;
    if (typeof r.durationMs === "number" && r.durationMs >= 0) {
      durations.push({ url: r.url, method: r.method, durationMs: r.durationMs, status: r.status });
    }

    if (typeof r.status === "number") {
      const bucket = `${Math.floor(r.status / 100)}xx`;
      byStatusBucket[bucket] = (byStatusBucket[bucket] || 0) + 1;
    } else {
      byStatusBucket.failed_or_pending++;
    }

    const m = r.method || "UNKNOWN";
    byMethod[m] = (byMethod[m] || 0) + 1;

    const t = r.resourceType || "Other";
    byResourceType[t] = (byResourceType[t] || 0) + 1;

    try {
      const host = new URL(r.url).hostname || "unknown";
      if (!byDomain[host]) byDomain[host] = { count: 0, totalBytes: 0, errors: 0 };
      byDomain[host].count++;
      byDomain[host].totalBytes += r.encodedDataLength || 0;
      if (r.errorText || (r.status && r.status >= 400)) byDomain[host].errors++;
    } catch (_) {}
  }

  durations.sort((a, b) => a.durationMs - b.durationMs);
  const pickPercentile = (p) => {
    if (!durations.length) return 0;
    const idx = Math.min(durations.length - 1, Math.floor((p / 100) * durations.length));
    return durations[idx].durationMs;
  };

  const avgMs = durations.length
    ? Number((durations.reduce((acc, c) => acc + c.durationMs, 0) / durations.length).toFixed(2))
    : 0;

  return {
    captureWindow: {
      startedAt: state.startedAt,
      exportedAt: new Date().toISOString(),
      totalDurationSeconds: Number(((Date.now() - state.startedEpochMs) / 1000).toFixed(2))
    },
    totals: {
      totalRequests: entries.length,
      totalWebSockets: wsEntries.length,
      totalTransferredBytes: totalBytes,
      totalTransferredMB: Number((totalBytes / (1024 * 1024)).toFixed(3)),
      failedRequests: failedCount,
      cachedOrServiceWorkerRequests: cachedCount
    },
    latencyMs: {
      averageMs: avgMs,
      p50Ms: pickPercentile(50),
      p90Ms: pickPercentile(90),
      p95Ms: pickPercentile(95),
      p99Ms: pickPercentile(99),
      slowestTop10: [...durations].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10)
    },
    breakdownByStatus: byStatusBucket,
    breakdownByMethod: byMethod,
    breakdownByResourceType: byResourceType,
    breakdownByDomain: byDomain
  };
}

async function exportCurrentSession(tabId, detachAfter) {
  const state = sessions.get(tabId);
  if (!state) return { ok: false, error: "No active session on this tab." };

  if (detachAfter) {
    try { await chrome.debugger.detach({ tabId }); } catch (_) {}
  }

  const payload = {
    meta: {
      exporter: "Bench NetTap MV3 (chrome.debugger)",
      targetTabId: tabId,
      targetUrl: state.targetUrl
    },
    analytics: computeAnalytics(state),
    requests: Array.from(state.requests.values()),
    websockets: Array.from(state.websockets.values())
  };

  const jsonString = JSON.stringify(payload, null, 2);
  const dataUrl = "data:application/json;charset=utf-8," + encodeURIComponent(jsonString);
  const safeHost = (() => {
    try { return new URL(state.targetUrl).hostname.replace(/[^a-zA-Z0-9.-]/g, "_"); }
    catch (_) { return "tab"; }
  })();

  await chrome.downloads.download({
    url: dataUrl,
    filename: `nettap_${safeHost}_${Date.now()}.json`,
    saveAs: true
  });

  if (detachAfter) sessions.delete(tabId);

  return {
    ok: true,
    exportedRequests: payload.requests.length,
    exportedWebSockets: payload.websockets.length
  };
}