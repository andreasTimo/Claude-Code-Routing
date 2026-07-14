import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

loadDotEnv();

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 120_000);
const STREAM_IDLE_TIMEOUT_MS = Number(process.env.STREAM_IDLE_TIMEOUT_MS || 60_000);
const SSE_HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS || 0);
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 3);
const PROXY_AUTH_TOKEN = process.env.PROXY_AUTH_TOKEN || "";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

const UNSAFE_RESPONSE_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  "content-encoding",
  "content-length",
  "content-md5",
  "etag",
  "vary"
]);

const RETRYABLE_STATUS_CODES = new Set([402, 408, 409, 425, 429, 500, 502, 503, 504, 529]);
const CLAUDE_CODE_MODEL_SUFFIX_RE = /\[[^\]]+\]$/;

function loadDotEnv() {
  if (!existsSync(".env")) return;

  const lines = readFileSync(".env", "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function loadProviders() {
  if (process.env.PROVIDERS_JSON) {
    const parsed = JSON.parse(process.env.PROVIDERS_JSON);
    if (!Array.isArray(parsed)) {
      throw new Error("PROVIDERS_JSON must be an array.");
    }
    return parsed.map(normalizeProvider);
  }

  const providers = [];
  for (let index = 1; index <= 50; index += 1) {
    const prefix = `ANTHROPIC_PROVIDER_${index}_`;
    const baseUrl = process.env[`${prefix}BASE_URL`];
    const authToken = process.env[`${prefix}AUTH_TOKEN`];
    if (!baseUrl && !authToken) continue;
    providers.push(normalizeProvider({
      name: process.env[`${prefix}NAME`] || `provider-${index}`,
      baseUrl,
      authToken
    }));
  }

  return providers;
}

function normalizeProvider(provider) {
  if (!provider?.baseUrl) {
    throw new Error(`Provider ${provider?.name || "(unnamed)"} is missing baseUrl.`);
  }
  if (!provider?.authToken) {
    throw new Error(`Provider ${provider?.name || provider.baseUrl} is missing authToken.`);
  }
  return {
    name: provider.name || provider.baseUrl,
    baseUrl: provider.baseUrl.replace(/\/+$/, ""),
    authToken: provider.authToken
  };
}

const providers = loadProviders();

if (providers.length === 0) {
  throw new Error("No providers configured. Set ANTHROPIC_PROVIDER_1_* or PROVIDERS_JSON.");
}

function json(res, statusCode, data) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(data, null, 2));
}

function log(message, data = {}) {
  const details = Object.entries(data)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  console.log(`[${new Date().toISOString()}] ${message}${details ? ` ${details}` : ""}`);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function normalizeClaudeCodeModel(model) {
  if (typeof model !== "string") return model;
  return model.replace(CLAUDE_CODE_MODEL_SUFFIX_RE, "");
}

function prepareUpstreamBody(req, body) {
  if (body.length === 0 || req.method === "GET" || req.method === "HEAD") return body;

  const contentType = String(req.headers["content-type"] || "");
  if (!contentType.includes("application/json")) return body;

  try {
    const payload = JSON.parse(body.toString("utf8"));
    const normalizedModel = normalizeClaudeCodeModel(payload.model);
    if (normalizedModel === payload.model) return body;

    payload.model = normalizedModel;
    return Buffer.from(JSON.stringify(payload));
  } catch {
    return body;
  }
}

function buildUpstreamHeaders(req, provider) {
  const headers = {};

  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (lower === "host") continue;
    if (lower === "authorization") continue;
    if (lower === "x-api-key") continue;
    if (lower === "accept-encoding") continue;
    if (lower === "content-length") continue;
    if (typeof value !== "undefined") headers[name] = value;
  }

  if (provider.authToken && provider.authToken !== "dummy") {
    headers.authorization = `Bearer ${provider.authToken}`;
    headers["x-api-key"] = provider.authToken;
  }
  headers["accept-encoding"] = "identity";

  if (!headers["anthropic-version"]) {
    headers["anthropic-version"] = "2023-06-01";
  }

  return headers;
}

function copyResponseHeaders(upstreamResponse) {
  const headers = {};
  upstreamResponse.headers.forEach((value, name) => {
    if (!UNSAFE_RESPONSE_HEADERS.has(name.toLowerCase())) {
      headers[name] = value;
    }
  });
  return headers;
}

function stripThinkingContent(payload) {
  if (!payload || typeof payload !== "object") return payload;

  if (Array.isArray(payload.content)) {
    payload.content = payload.content.filter((item) => {
      return item?.type !== "thinking" && item?.type !== "redacted_thinking";
    });
  }

  return payload;
}

function normalizeNonStreamSuccessBody(text) {
  const trimmed = text.trim();
  if (!trimmed) return "";

  try {
    return JSON.stringify(stripThinkingContent(JSON.parse(trimmed)));
  } catch {
    // Some Anthropic-compatible gateways return JSON followed by an SSE terminator.
  }

  const doneIndex = trimmed.indexOf("data: [DONE]");
  if (doneIndex !== -1) {
    const candidate = trimmed.slice(0, doneIndex).trim();
    try {
      return JSON.stringify(stripThinkingContent(JSON.parse(candidate)));
    } catch {
      return trimmed;
    }
  }

  return trimmed;
}

function createAnthropicStreamNormalizer() {
  let pendingText = "";
  const thinkingIndexes = new Set();

  const shouldDropEvent = (eventText) => {
    const lines = eventText.split(/\r?\n/);
    const dataLines = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());

    if (dataLines.length === 1 && dataLines[0] === "[DONE]") return true;
    if (dataLines.length === 0) return false;

    try {
      const payload = JSON.parse(dataLines.join("\n"));
      if (
        payload?.type === "content_block_start" &&
        (payload.content_block?.type === "thinking" ||
          payload.content_block?.type === "redacted_thinking")
      ) {
        thinkingIndexes.add(payload.index);
        return true;
      }

      if (
        payload?.type === "content_block_delta" &&
        (payload.delta?.type === "thinking_delta" ||
          payload.delta?.type === "redacted_thinking_delta")
      ) {
        return true;
      }

      if (payload?.type === "content_block_stop" && thinkingIndexes.has(payload.index)) {
        thinkingIndexes.delete(payload.index);
        return true;
      }
    } catch {
      return false;
    }

    return false;
  };

  const normalizeEvents = (text) => {
    const parts = text.split(/\r?\n\r?\n/);
    pendingText = parts.pop() || "";

    return parts
      .filter((eventText) => eventText.trim() && !shouldDropEvent(eventText))
      .map((eventText) => `${eventText}\n\n`)
      .join("");
  };

  return {
    write(chunk) {
      pendingText += chunk.toString("utf8");
      const normalized = normalizeEvents(pendingText);
      return normalized ? Buffer.from(normalized) : Buffer.alloc(0);
    },
    end() {
      const normalized = pendingText.trim() && !shouldDropEvent(pendingText)
        ? `${pendingText}\n\n`
        : "";
      pendingText = "";
      return normalized ? Buffer.from(normalized) : Buffer.alloc(0);
    }
  };
}

function shouldFallback(statusCode, bodyText) {
  if (RETRYABLE_STATUS_CODES.has(statusCode)) return true;

  const text = bodyText.toLowerCase();
  return (
    text.includes("rate_limit") ||
    text.includes("rate limit") ||
    text.includes("quota") ||
    text.includes("credit") ||
    text.includes("billing") ||
    text.includes("insufficient") ||
    text.includes("temporarily unavailable") ||
    text.includes("temporary unavailable") ||
    text.includes("is unavailable") ||
    text.includes("currently unavailable")
  );
}

function isStreamRequest(req, body) {
  const accept = String(req.headers.accept || "");
  if (accept.includes("text/event-stream")) return true;

  try {
    const parsed = JSON.parse(body.toString("utf8"));
    return parsed?.stream === true;
  } catch {
    return false;
  }
}

async function proxyToProvider(req, provider, body, signal) {
  const upstreamUrl = new URL(req.url || "/", provider.baseUrl);
  return await fetch(upstreamUrl, {
    method: req.method,
    headers: buildUpstreamHeaders(req, provider),
    body: body.length > 0 && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
    signal
  });
}

async function pipeUpstreamBody(upstreamResponse, res, {
  controller,
  headers,
  provider,
  statusCode,
  streamRequest
}) {
  let idleTimer;
  let heartbeatTimer;
  let wroteBody = false;
  const streamNormalizer = streamRequest ? createAnthropicStreamNormalizer() : null;

  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  const resetIdleTimer = () => {
    clearIdleTimer();
    if (STREAM_IDLE_TIMEOUT_MS <= 0) return;

    idleTimer = setTimeout(() => {
      const error = new Error(`Upstream stream idle for ${STREAM_IDLE_TIMEOUT_MS}ms`);
      log("upstream_stream_idle", {
        provider: provider.name,
        idleMs: STREAM_IDLE_TIMEOUT_MS
      });
      controller.abort(error);
      if (res.headersSent && !res.destroyed && !res.writableEnded) {
        res.destroy(error);
      }
    }, STREAM_IDLE_TIMEOUT_MS);
  };

  if (streamRequest && SSE_HEARTBEAT_MS > 0) {
    heartbeatTimer = setInterval(() => {
      if (res.headersSent && !res.destroyed && !res.writableEnded) {
        res.write(": proxy-keepalive\n\n");
      }
    }, SSE_HEARTBEAT_MS);
  }

  resetIdleTimer();

  try {
    if (upstreamResponse.body) {
      for await (const chunk of upstreamResponse.body) {
        resetIdleTimer();
        let buffer = Buffer.from(chunk);
        if (streamNormalizer) {
          buffer = streamNormalizer.write(buffer);
        }
        if (buffer.length === 0) continue;

        if (!res.headersSent) {
          res.writeHead(statusCode, headers);
        }
        wroteBody = true;
        res.write(buffer);
      }
    }

    if (streamNormalizer) {
      const finalBuffer = streamNormalizer.end();
      if (finalBuffer.length > 0) {
        if (!res.headersSent) {
          res.writeHead(statusCode, headers);
        }
        wroteBody = true;
        res.write(finalBuffer);
      }
    }

    if (wroteBody && !res.destroyed && !res.writableEnded) {
      res.end();
    }

    return wroteBody;
  } finally {
    clearIdleTimer();
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
  }
}

async function handleProxy(req, res) {
  if (PROXY_AUTH_TOKEN) {
    const expected = `Bearer ${PROXY_AUTH_TOKEN}`;
    if (req.headers.authorization !== expected && req.headers["x-api-key"] !== PROXY_AUTH_TOKEN) {
      json(res, 401, { error: { type: "unauthorized", message: "Invalid proxy token." } });
      return;
    }
  }

  const body = await readBody(req);
  const upstreamBody = prepareUpstreamBody(req, body);
  const streamRequest = isStreamRequest(req, body);
  const errors = [];
  const attemptLimit = Math.min(MAX_ATTEMPTS, providers.length);

  for (let attempt = 0; attempt < attemptLimit; attempt += 1) {
    const provider = providers[attempt];
    const controller = new AbortController();
    let responseCompleted = false;
    const abortOnClientClose = () => {
      if (!responseCompleted && !res.writableEnded) {
        controller.abort(new Error("Client connection closed before upstream completed"));
      }
    };
    const responseTimeout = setTimeout(() => {
      controller.abort(new Error(`Upstream response timeout after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);
    res.once("close", abortOnClientClose);

    try {
      log("upstream_attempt", {
        method: req.method,
        path: req.url || "/",
        provider: provider.name,
        attempt: attempt + 1
      });

      const upstreamResponse = await proxyToProvider(req, provider, upstreamBody, controller.signal);
      const headers = copyResponseHeaders(upstreamResponse);
      headers["x-fallback-provider"] = provider.name;
      headers["x-fallback-attempt"] = String(attempt + 1);

      if (upstreamResponse.ok) {
        log("upstream_success", {
          provider: provider.name,
          status: upstreamResponse.status,
          attempt: attempt + 1
        });

        if (!streamRequest) {
          const responseText = normalizeNonStreamSuccessBody(await upstreamResponse.text());
          clearTimeout(responseTimeout);
          responseCompleted = true;

          if (!responseText) {
            log("upstream_empty_success", {
              provider: provider.name,
              attempt: attempt + 1,
              fallback: attempt !== attemptLimit - 1
            });
            errors.push({
              provider: provider.name,
              status: upstreamResponse.status,
              body: "Empty successful response body."
            });

            if (attempt !== attemptLimit - 1) {
              await delay(Math.min(250 * (attempt + 1), 1000));
              continue;
            }

            json(res, 502, {
              error: {
                type: "empty_upstream_response",
                message: "Upstream returned HTTP 200 with an empty body.",
                attempts: errors
              }
            });
            return;
          }

          res.writeHead(upstreamResponse.status, {
            ...headers,
            "content-type": "application/json; charset=utf-8"
          });
          res.end(responseText);
          return;
        }

        clearTimeout(responseTimeout);
        try {
          const wroteBody = await pipeUpstreamBody(upstreamResponse, res, {
            controller,
            headers,
            provider,
            statusCode: upstreamResponse.status,
            streamRequest
          });
          responseCompleted = true;

          if (!wroteBody) {
            log("upstream_empty_success", {
              provider: provider.name,
              attempt: attempt + 1,
              fallback: attempt !== attemptLimit - 1
            });
            errors.push({
              provider: provider.name,
              status: upstreamResponse.status,
              body: "Empty successful response body."
            });

            if (attempt !== attemptLimit - 1) {
              await delay(Math.min(250 * (attempt + 1), 1000));
              continue;
            }

            json(res, 502, {
              error: {
                type: "empty_upstream_response",
                message: "Upstream returned HTTP 200 with an empty body.",
                attempts: errors
              }
            });
          }
        } catch (streamError) {
          log("upstream_stream_error", {
            provider: provider.name,
            attempt: attempt + 1,
            error: streamError instanceof Error ? streamError.message : String(streamError)
          });
          if (res.headersSent && !res.destroyed && !res.writableEnded) {
            res.destroy(streamError instanceof Error ? streamError : new Error(String(streamError)));
          } else if (attempt === attemptLimit - 1) {
            json(res, 502, {
              error: {
                type: "upstream_stream_error",
                message: streamError instanceof Error ? streamError.message : String(streamError)
              }
            });
          } else {
            errors.push({
              provider: provider.name,
              status: "stream_error",
              body: streamError instanceof Error ? streamError.message : String(streamError)
            });
            await delay(Math.min(250 * (attempt + 1), 1000));
            continue;
          }
        }
        return;
      }

      const errorText = await upstreamResponse.text();
      clearTimeout(responseTimeout);
      log("upstream_error", {
        provider: provider.name,
        status: upstreamResponse.status,
        attempt: attempt + 1,
        fallback: shouldFallback(upstreamResponse.status, errorText)
      });
      errors.push({
        provider: provider.name,
        status: upstreamResponse.status,
        body: safeJsonText(errorText)
      });

      if (!shouldFallback(upstreamResponse.status, errorText) || attempt === attemptLimit - 1) {
        res.writeHead(upstreamResponse.status, {
          ...headers,
          "content-type": upstreamResponse.headers.get("content-type") || "application/json; charset=utf-8"
        });
        res.end(errorText);
        responseCompleted = true;
        return;
      }

      if (!streamRequest) {
        await delay(Math.min(250 * (attempt + 1), 1000));
      }
    } catch (error) {
      const cause = error instanceof Error && error.cause ? error.cause : null;
      log("upstream_network_error", {
        provider: provider.name,
        attempt: attempt + 1,
        error: error instanceof Error ? error.message : String(error),
        cause: cause instanceof Error ? cause.message : cause ? String(cause) : ""
      });
      errors.push({
        provider: provider.name,
        status: "network_error",
        body: error instanceof Error ? `${error.message}${cause ? `: ${cause}` : ""}` : String(error)
      });

      if (attempt === attemptLimit - 1) {
        responseCompleted = true;
        json(res, 502, {
          error: {
            type: "fallback_exhausted",
            message: "All configured providers failed.",
            attempts: errors
          }
        });
        return;
      }

      await delay(Math.min(250 * (attempt + 1), 1000));
    } finally {
      clearTimeout(responseTimeout);
      res.off("close", abortOnClientClose);
    }
  }

  if (!res.writableEnded) {
    json(res, 502, {
      error: {
        type: "fallback_exhausted",
        message: "No provider returned a usable response.",
        attempts: errors
      }
    });
  }
}

function safeJsonText(text) {
  if (text.length <= 1000) return text;
  return `${text.slice(0, 1000)}...`;
}

const server = http.createServer(async (req, res) => {
  try {
    log("request", { method: req.method, path: req.url || "/" });

    if (req.url === "/health") {
      json(res, 200, {
        ok: true,
        providers: providers.map((provider) => provider.name)
      });
      return;
    }

    if (req.url === "/" && req.method === "GET") {
      json(res, 200, {
        name: "anthropic-fallback-proxy",
        endpoints: ["/v1/messages", "/v1/models", "/health"]
      });
      return;
    }

    await handleProxy(req, res);
  } catch (error) {
    json(res, 500, {
      error: {
        type: "proxy_error",
        message: error instanceof Error ? error.message : String(error)
      }
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Anthropic fallback proxy listening on http://${HOST}:${PORT}`);
  console.log(`Configured providers: ${providers.map((provider) => provider.name).join(", ")}`);
});
