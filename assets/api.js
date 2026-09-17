import { apiUrl } from "./config.js";

export class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

// Calls the backend. POST with text/plain so the browser skips the CORS preflight
// (Apps Script web apps cannot answer OPTIONS requests).
export async function call(action, params = {}, { timeoutMs = 30000, signal } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException("timeout", "TimeoutError")), timeoutMs);
  const onAbort = () => ctrl.abort(signal.reason);
  if (signal) signal.addEventListener("abort", onAbort, { once: true });

  let res;
  try {
    res = await fetch(apiUrl(), {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action, ...params }),
      redirect: "follow",
      signal: ctrl.signal,
    });
  } catch (err) {
    const timedOut = ctrl.signal.reason?.name === "TimeoutError";
    throw new ApiError(timedOut ? "timeout" : "network", timedOut ? "The server took too long to answer." : "Could not reach the server.");
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new ApiError("bad_response", `Unexpected response from the server (HTTP ${res.status}).`);
  }
  if (!data || data.ok !== true) {
    throw new ApiError(data?.error?.code || "server_error", data?.error?.message || "Unknown server error.");
  }
  return data.result;
}
