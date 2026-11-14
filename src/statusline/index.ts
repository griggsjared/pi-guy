import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { PROVIDER_USAGE_REQUEST_EVENT } from "../lib/events.ts";
import type { ProviderUsageRequest } from "../lib/events.ts";
import { formatFooterBalance, formatFooterUsage, registerStatusline } from "./footer.ts";
import { REQUEST_TIMEOUT_MS } from "./http.ts";
import {
  ANTHROPIC_CACHE_TTL_MS,
  ANTHROPIC_PROVIDER,
  fetchAnthropicUsage,
  normalizeAnthropicHeaders,
} from "./providers/anthropic.ts";
import {
  CLAUDE_BRIDGE_CACHE_TTL_MS,
  CLAUDE_BRIDGE_REQUEST_INTERVAL_MS,
  CLAUDE_BRIDGE_PROVIDER,
  CLAUDE_BRIDGE_STALE_AFTER_MS,
  fetchClaudeBridgeUsage,
} from "./providers/claude-bridge.ts";
import { saveClaudeUsage } from "./providers/claude-cli.ts";
import {
  CLAUDE_CODE_CACHE_TTL_MS,
  CLAUDE_CODE_REQUEST_INTERVAL_MS,
  CLAUDE_CODE_PROVIDER,
  CLAUDE_CODE_STALE_AFTER_MS,
  fetchClaudeCodeUsage,
  normalizeClaudeCodeRateLimit,
} from "./providers/claude-code.ts";
import { CODEX_CACHE_TTL_MS, CODEX_PROVIDER, fetchCodexUsage } from "./providers/codex.ts";
import { DEEPSEEK_CACHE_TTL_MS, DEEPSEEK_PROVIDER, fetchDeepseekUsage } from "./providers/deepseek.ts";
import { OPENCODE_CACHE_TTL_MS, OPENCODE_PROVIDER, fetchOpencodeUsage } from "./providers/opencode.ts";
import { encodeUsageStatus, isUsageProvider, USAGE_STATUS_KEY } from "./usage-status.ts";
import type { UsageProvider, UsageStatus } from "./usage-status.ts";

const REFRESH_INTERVAL_MS = 60_000;

interface UsageAdapter {
  cacheTtlMs: number;
  /**
   * Shortest time between requests, so sessions sharing a rate-limited login do not ask every minute
   * after a failure or an old reading. In between, load is called with savedOnly and must not make a request.
   */
  requestIntervalMs?: number;
  /** Stop showing a reading this old when it cannot be renewed. */
  staleAfterMs?: number;
  load(ctx: ExtensionContext, signal: AbortSignal, savedOnly?: boolean): Promise<UsageStatus>;
}

const USAGE_ADAPTERS: Record<UsageProvider, UsageAdapter> = {
  [ANTHROPIC_PROVIDER]: { cacheTtlMs: ANTHROPIC_CACHE_TTL_MS, load: fetchAnthropicUsage },
  [CLAUDE_BRIDGE_PROVIDER]: {
    cacheTtlMs: CLAUDE_BRIDGE_CACHE_TTL_MS,
    requestIntervalMs: CLAUDE_BRIDGE_REQUEST_INTERVAL_MS,
    staleAfterMs: CLAUDE_BRIDGE_STALE_AFTER_MS,
    load: fetchClaudeBridgeUsage,
  },
  [CLAUDE_CODE_PROVIDER]: {
    cacheTtlMs: CLAUDE_CODE_CACHE_TTL_MS,
    requestIntervalMs: CLAUDE_CODE_REQUEST_INTERVAL_MS,
    staleAfterMs: CLAUDE_CODE_STALE_AFTER_MS,
    load: fetchClaudeCodeUsage,
  },
  [CODEX_PROVIDER]: { cacheTtlMs: CODEX_CACHE_TTL_MS, load: fetchCodexUsage },
  [OPENCODE_PROVIDER]: { cacheTtlMs: OPENCODE_CACHE_TTL_MS, load: (_ctx, signal) => fetchOpencodeUsage(signal) },
  [DEEPSEEK_PROVIDER]: { cacheTtlMs: DEEPSEEK_CACHE_TTL_MS, load: fetchDeepseekUsage },
};

function isProviderUsageRequest(value: unknown): value is ProviderUsageRequest {
  if (!value || typeof value !== "object") return false;
  const { provider, theme, reply } = value as Record<string, unknown>;
  return (
    typeof provider === "string" &&
    typeof reply === "function" &&
    !!theme &&
    typeof theme === "object" &&
    typeof (theme as { fg?: unknown }).fg === "function"
  );
}

// Mirrors the footer's right-hand usage text, without width limits.
function formatRequestedUsage(usage: UsageStatus | undefined, theme: Pick<Theme, "fg">): string | undefined {
  if (usage?.state !== "ready") return undefined;
  const parts = usage.windows.length > 0 ? [formatFooterUsage(usage, Date.now(), Infinity, theme)] : [];
  if (usage.balance) {
    parts.push(formatFooterBalance(usage.balance, theme));
  }
  return parts.length > 0 ? parts.join(" ") : theme.fg("dim", "no quota");
}

export default function (pi: ExtensionAPI) {
  registerStatusline(pi);
  let activeContext: ExtensionContext | undefined;
  let activeProvider: string | undefined;
  let latestUsage: UsageStatus | undefined;
  let lastFetchedAt = 0;
  let lastRequestAt: number | undefined;
  let generation = 0;
  let refreshPromise: Promise<void> | undefined;
  let requestController: AbortController | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let sessionActive = false;
  // Usage for non-active providers, fetched on request and never published to the footer.
  let sessionGeneration = 0;
  const providerCache = new Map<UsageProvider, { status: UsageStatus; fetchedAt: number }>();
  const providerRequests = new Map<
    UsageProvider,
    { controller: AbortController; promise: Promise<UsageStatus | undefined> }
  >();

  const supported = (provider: string | undefined): provider is UsageProvider => isUsageProvider(provider);

  const clearRequest = (): void => {
    requestController?.abort();
    requestController = undefined;
    refreshPromise = undefined;
  };

  const clearProviderUsage = (): void => {
    sessionGeneration++;
    for (const { controller } of providerRequests.values()) controller.abort();
    providerRequests.clear();
    providerCache.clear();
  };

  const clearUsage = (ctx: ExtensionContext): void => {
    latestUsage = undefined;
    lastFetchedAt = 0;
    lastRequestAt = undefined;
    if (ctx.hasUI) ctx.ui.setStatus(USAGE_STATUS_KEY, undefined);
  };

  const publish = (ctx: ExtensionContext, usage: UsageStatus | undefined): void => {
    if (!ctx.hasUI) return;
    if (usage) {
      ctx.ui.setStatus(USAGE_STATUS_KEY, encodeUsageStatus(usage));
      return;
    }
    const provider = ctx.model?.provider;
    if (!provider || !supported(provider)) {
      ctx.ui.setStatus(USAGE_STATUS_KEY, undefined);
      return;
    }
    ctx.ui.setStatus(
      USAGE_STATUS_KEY,
      encodeUsageStatus({
        provider,
        state: "unknown",
        windows: [],
        capturedAtMs: Date.now(),
      }),
    );
  };

  const refresh = (ctx: ExtensionContext): Promise<void> => {
    const provider = ctx.model?.provider;
    if (!ctx.hasUI || !supported(provider)) {
      if (ctx.hasUI && supported(activeProvider)) clearUsage(ctx);
      return Promise.resolve();
    }

    const adapter = USAGE_ADAPTERS[provider];
    if (latestUsage?.provider === provider && Date.now() - lastFetchedAt < adapter.cacheTtlMs) {
      publish(ctx, latestUsage);
      return Promise.resolve();
    }
    if (refreshPromise) return refreshPromise;
    const savedOnly =
      !!adapter.requestIntervalMs &&
      lastRequestAt !== undefined &&
      Date.now() - lastRequestAt < adapter.requestIntervalMs;

    const requestGeneration = generation;
    const controller = new AbortController();
    requestController = controller;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const promise = (async () => {
      try {
        const usage = await adapter.load(ctx, controller.signal, savedOnly);
        if (!sessionActive || requestGeneration !== generation || ctx.model?.provider !== activeProvider) return;
        // The Claude CLI can return a saved reading older than the value from the last reply.
        if (latestUsage?.provider !== usage.provider || usage.capturedAtMs >= latestUsage.capturedAtMs)
          latestUsage = usage;
        // A saved Claude reading can already be minutes old, so its cache lifetime runs from when it was taken.
        lastFetchedAt = latestUsage.capturedAtMs;
        if (!savedOnly) lastRequestAt = Date.now();
        publish(ctx, latestUsage);
      } catch {
        if (!sessionActive || requestGeneration !== generation || ctx.model?.provider !== provider) return;
        if (!savedOnly) lastRequestAt = Date.now();
        if (
          latestUsage?.provider === provider &&
          adapter.staleAfterMs &&
          Date.now() - latestUsage.capturedAtMs >= adapter.staleAfterMs
        )
          latestUsage = undefined;
        if (latestUsage?.provider === provider) publish(ctx, latestUsage);
        else publish(ctx, undefined);
      } finally {
        clearTimeout(timeout);
        if (requestController === controller) requestController = undefined;
      }
    })();
    refreshPromise = promise;
    promise.then(
      () => {
        if (refreshPromise === promise) refreshPromise = undefined;
      },
      () => {
        if (refreshPromise === promise) refreshPromise = undefined;
      },
    );
    return promise;
  };

  const fetchProviderUsage = (
    provider: UsageProvider,
    adapter: UsageAdapter,
    ctx: ExtensionContext,
  ): Promise<UsageStatus | undefined> => {
    const cached = providerCache.get(provider);
    if (cached && Date.now() - cached.fetchedAt < adapter.cacheTtlMs) return Promise.resolve(cached.status);
    const inFlight = providerRequests.get(provider);
    if (inFlight) return inFlight.promise;

    const requestGeneration = sessionGeneration;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const promise = (async () => {
      try {
        const usage = await adapter.load(ctx, controller.signal);
        if (requestGeneration !== sessionGeneration) return undefined;
        providerCache.set(provider, { status: usage, fetchedAt: Date.now() });
        return usage;
      } catch {
        return requestGeneration === sessionGeneration ? providerCache.get(provider)?.status : undefined;
      } finally {
        clearTimeout(timeout);
      }
    })();
    providerRequests.set(provider, { controller, promise });
    void promise.then(() => {
      if (providerRequests.get(provider)?.promise === promise) providerRequests.delete(provider);
    });
    return promise;
  };

  pi.events.on(PROVIDER_USAGE_REQUEST_EVENT, (data) => {
    if (!isProviderUsageRequest(data)) return;
    const { provider, theme, reply } = data;
    const ctx = activeContext;
    if (!sessionActive || !ctx || !supported(provider)) {
      reply(undefined);
      return;
    }
    if (provider === activeProvider) {
      void refresh(ctx).then(() =>
        reply(formatRequestedUsage(latestUsage?.provider === provider ? latestUsage : undefined, theme)),
      );
    } else {
      void fetchProviderUsage(provider, USAGE_ADAPTERS[provider], ctx).then((usage) =>
        reply(formatRequestedUsage(usage, theme)),
      );
    }
  });

  pi.on("session_start", (_event, ctx) => {
    // A reload can start a new runtime without delivering the old shutdown
    // event. Do not let an in-flight request or cached quota cross sessions.
    generation++;
    clearRequest();
    clearProviderUsage();
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    latestUsage = undefined;
    lastFetchedAt = 0;
    lastRequestAt = undefined;
    sessionActive = true;
    activeContext = ctx;
    activeProvider = ctx.model?.provider;
    if (ctx.hasUI && supported(activeProvider)) publish(ctx, undefined);
    else if (ctx.hasUI) clearUsage(ctx);
    if (ctx.hasUI && !refreshTimer) {
      refreshTimer = setInterval(() => {
        if (activeContext && supported(activeProvider)) void refresh(activeContext);
      }, REFRESH_INTERVAL_MS);
    }
    void refresh(ctx);
  });

  pi.on("model_select", (event, ctx) => {
    activeContext = ctx;
    const provider = event.model.provider;
    if (provider !== activeProvider) {
      generation++;
      clearRequest();
      activeProvider = provider;
      clearUsage(ctx);
    } else if (supported(provider)) {
      // A same-provider model selection can refresh credentials; invalidate
      // any request and cached quota associated with the old credentials.
      generation++;
      clearRequest();
      clearUsage(ctx);
    }
    if (supported(provider)) {
      publish(ctx, latestUsage?.provider === provider ? latestUsage : undefined);
      void refresh(ctx);
    }
  });

  pi.on("after_provider_response", (event, ctx) => {
    const provider = ctx.model?.provider;
    if (!sessionActive || !ctx.hasUI || (provider !== ANTHROPIC_PROVIDER && provider !== CLAUDE_BRIDGE_PROVIDER))
      return;
    const usage = normalizeAnthropicHeaders(event.headers);
    if (usage) {
      if (provider === CLAUDE_BRIDGE_PROVIDER && latestUsage?.provider === provider && latestUsage.state === "ready") {
        usage.windows.push(
          ...latestUsage.windows.filter((window) => !usage.windows.some((update) => update.kind === window.kind)),
        );
        usage.windows.sort((a, b) => a.kind.localeCompare(b.kind));
      }
      latestUsage = { ...usage, provider };
      // Usable header updates renew the fetch cache.
      lastFetchedAt = Date.now();
      if (provider === CLAUDE_BRIDGE_PROVIDER) void saveClaudeUsage(latestUsage);
      publish(ctx, latestUsage);
    } else if (provider === ANTHROPIC_PROVIDER && event.status < 400 && latestUsage?.provider !== ANTHROPIC_PROVIDER) {
      // A successful reply without plan headers means an API key, which has no quota to show.
      publish(ctx, { provider: ANTHROPIC_PROVIDER, state: "ready", windows: [], capturedAtMs: Date.now() });
    }
  });

  pi.on("turn_end", (event, ctx) => {
    activeContext = ctx;
    if (sessionActive && ctx.hasUI && ctx.model?.provider === CLAUDE_CODE_PROVIDER) {
      const usage = normalizeClaudeCodeRateLimit(event.message);
      if (usage) {
        latestUsage = usage;
        // Like usable response headers, a reply's rate-limit status renews the fetch cache.
        lastFetchedAt = Date.now();
        void saveClaudeUsage(usage);
      }
    }
    if (supported(ctx.model?.provider)) void refresh(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    sessionActive = false;
    generation++;
    clearRequest();
    clearProviderUsage();
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    activeContext = undefined;
    activeProvider = undefined;
    latestUsage = undefined;
    lastFetchedAt = 0;
    lastRequestAt = undefined;
    if (ctx.hasUI) ctx.ui.setStatus(USAGE_STATUS_KEY, undefined);
  });
}
