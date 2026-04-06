import rawModels from "./cursor-models-raw.json" with { type: "json" };
import { describe, expect, test } from "bun:test";
import { buildEffortMap, FALLBACK_MODELS, parseModelId, processModels, supportsReasoningModelId } from "./index.ts";
import { resolveModelId, deriveBridgeKey, deriveConversationKey, deterministicConversationId, detectForkAndInvalidate, inlineConversationHistory } from "./proxy.ts";
import type { CursorModel, StoredConversation } from "./proxy.ts";

// ── Helper ──

function m(id: string, name?: string): CursorModel {
  return { id, name: name ?? id, reasoning: true, contextWindow: 200_000, maxTokens: 64_000 };
}

// ── parseModelId ──

describe("parseModelId", () => {
  test("plain model — no effort, no variant", () => {
    expect(parseModelId("composer-2")).toEqual({ base: "composer-2", effort: "", fast: false, thinking: false });
  });

  test("plain model with -fast suffix", () => {
    expect(parseModelId("composer-2-fast")).toEqual({ base: "composer-2", effort: "", fast: true, thinking: false });
  });

  test("model with effort suffix", () => {
    expect(parseModelId("gpt-5.4-medium")).toEqual({ base: "gpt-5.4", effort: "medium", fast: false, thinking: false });
  });

  test("model with effort + fast", () => {
    expect(parseModelId("gpt-5.4-high-fast")).toEqual({ base: "gpt-5.4", effort: "high", fast: true, thinking: false });
  });

  test("model with effort + thinking", () => {
    expect(parseModelId("claude-4.6-opus-high-thinking")).toEqual({ base: "claude-4.6-opus", effort: "high", fast: false, thinking: true });
  });

  test("max effort level", () => {
    expect(parseModelId("claude-4.6-opus-max")).toEqual({ base: "claude-4.6-opus", effort: "max", fast: false, thinking: false });
  });

  test("max effort + thinking", () => {
    expect(parseModelId("claude-4.6-opus-max-thinking")).toEqual({ base: "claude-4.6-opus", effort: "max", fast: false, thinking: true });
  });

  test("none effort level", () => {
    expect(parseModelId("gpt-5.4-mini-none")).toEqual({ base: "gpt-5.4-mini", effort: "none", fast: false, thinking: false });
  });

  test("xhigh effort", () => {
    expect(parseModelId("gpt-5.2-xhigh")).toEqual({ base: "gpt-5.2", effort: "xhigh", fast: false, thinking: false });
  });

  test("xhigh effort + fast", () => {
    expect(parseModelId("gpt-5.2-xhigh-fast")).toEqual({ base: "gpt-5.2", effort: "xhigh", fast: true, thinking: false });
  });

  test("codex-max model — max is part of base, not effort", () => {
    expect(parseModelId("gpt-5.1-codex-max-high")).toEqual({ base: "gpt-5.1-codex-max", effort: "high", fast: false, thinking: false });
  });

  test("codex-max + fast", () => {
    expect(parseModelId("gpt-5.1-codex-max-medium-fast")).toEqual({ base: "gpt-5.1-codex-max", effort: "medium", fast: true, thinking: false });
  });

  test("codex-mini model", () => {
    expect(parseModelId("gpt-5.1-codex-mini-high")).toEqual({ base: "gpt-5.1-codex-mini", effort: "high", fast: false, thinking: false });
  });

  test("spark-preview model", () => {
    expect(parseModelId("gpt-5.3-codex-spark-preview-high")).toEqual({ base: "gpt-5.3-codex-spark-preview", effort: "high", fast: false, thinking: false });
  });

  test("plain thinking model — no effort", () => {
    expect(parseModelId("grok-4-20-thinking")).toEqual({ base: "grok-4-20", effort: "", fast: false, thinking: true });
  });

  test("model without any suffix", () => {
    expect(parseModelId("kimi-k2.5")).toEqual({ base: "kimi-k2.5", effort: "", fast: false, thinking: false });
  });

  test("default model", () => {
    expect(parseModelId("default")).toEqual({ base: "default", effort: "", fast: false, thinking: false });
  });

  test("claude-4.6-sonnet-medium — effort is medium", () => {
    expect(parseModelId("claude-4.6-sonnet-medium")).toEqual({ base: "claude-4.6-sonnet", effort: "medium", fast: false, thinking: false });
  });

  test("claude-4.6-sonnet-medium-thinking", () => {
    expect(parseModelId("claude-4.6-sonnet-medium-thinking")).toEqual({ base: "claude-4.6-sonnet", effort: "medium", fast: false, thinking: true });
  });
});

// ── buildEffortMap ──

describe("buildEffortMap", () => {
  test("full range: none/low/medium/high/xhigh", () => {
    const map = buildEffortMap(new Set(["none", "low", "medium", "high", "xhigh"]));
    expect(map).toEqual({ minimal: "none", low: "low", medium: "medium", high: "high", xhigh: "xhigh" });
  });

  test("with default (empty) and medium", () => {
    const map = buildEffortMap(new Set(["", "low", "medium", "high"]));
    expect(map).toEqual({ minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high" });
  });

  test("default without medium — medium maps to empty", () => {
    const map = buildEffortMap(new Set(["", "low", "high", "xhigh"]));
    expect(map.medium).toBe("");
  });

  test("high+max only — all lower levels clamp to high", () => {
    const map = buildEffortMap(new Set(["high", "max"]));
    expect(map).toEqual({ minimal: "high", low: "high", medium: "high", high: "high", xhigh: "max" });
  });

  test("none+low+medium+high+max", () => {
    const map = buildEffortMap(new Set(["none", "low", "medium", "high", "max"]));
    expect(map).toEqual({ minimal: "none", low: "low", medium: "medium", high: "high", xhigh: "max" });
  });

  test("low+high — medium falls back to low", () => {
    const map = buildEffortMap(new Set(["low", "high"]));
    expect(map).toEqual({ minimal: "low", low: "low", medium: "low", high: "high", xhigh: "high" });
  });
});

// ── processModels ──

describe("reasoning support", () => {
  test("derives reasoning from model ids", () => {
    expect(supportsReasoningModelId("gpt-5.4")).toBe(true);
    expect(supportsReasoningModelId("gpt-5.4-fast")).toBe(true);
    expect(supportsReasoningModelId("composer-2")).toBe(true);
    expect(supportsReasoningModelId("default")).toBe(true);
    expect(supportsReasoningModelId("totally-unknown-model")).toBe(false);
  });

  test("fallback models keep derived reasoning enabled", () => {
    expect(FALLBACK_MODELS.length).toBeGreaterThan(0);
    expect(FALLBACK_MODELS.find((model) => model.id === "gpt-5.4-medium")?.reasoning).toBe(true);
    expect(FALLBACK_MODELS.find((model) => model.id === "composer-2")?.reasoning).toBe(true);
  });
});

describe("processModels", () => {
  test("composer-2 — no effort variants, kept as-is", () => {
    const result = processModels([m("composer-2"), m("composer-2-fast")]);
    const c2 = result.find(r => r.id === "composer-2");
    const c2f = result.find(r => r.id === "composer-2-fast");
    expect(c2).toBeDefined();
    expect(c2!.supportsEffort).toBe(false);
    expect(c2f).toBeDefined();
    expect(c2f!.supportsEffort).toBe(false);
  });

  test("gpt-5.4 — deduped from low/medium/high/xhigh", () => {
    const result = processModels([
      m("gpt-5.4-low"), m("gpt-5.4-medium"), m("gpt-5.4-high"), m("gpt-5.4-xhigh"),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("gpt-5.4");
    expect(result[0].supportsEffort).toBe(true);
    expect(result[0].effortMap!.medium).toBe("medium");
    expect(result[0].effortMap!.xhigh).toBe("xhigh");
  });

  test("gpt-5.4-fast — deduped from effort+fast variants", () => {
    const result = processModels([
      m("gpt-5.4-high-fast"), m("gpt-5.4-medium-fast"), m("gpt-5.4-xhigh-fast"),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("gpt-5.4-fast");
    expect(result[0].supportsEffort).toBe(true);
  });

  test("gpt-5.2 — deduped from default + effort variants", () => {
    const result = processModels([
      m("gpt-5.2"), m("gpt-5.2-high"), m("gpt-5.2-low"), m("gpt-5.2-xhigh"),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("gpt-5.2");
    expect(result[0].supportsEffort).toBe(true);
    expect(result[0].effortMap!.medium).toBe(""); // no-suffix = default
    expect(result[0].effortMap!.high).toBe("high");
  });

  test("gpt-5.4-mini — has none effort", () => {
    const result = processModels([
      m("gpt-5.4-mini-low"), m("gpt-5.4-mini-medium"), m("gpt-5.4-mini-high"),
      m("gpt-5.4-mini-xhigh"), m("gpt-5.4-mini-none"),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("gpt-5.4-mini");
    expect(result[0].supportsEffort).toBe(true);
    expect(result[0].effortMap!.minimal).toBe("none");
  });

  test("claude-4.6-opus — high+max deduped, effort clamped to lowest", () => {
    const result = processModels([
      m("claude-4.6-opus-high"), m("claude-4.6-opus-max"),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("claude-4.6-opus");
    expect(result[0].supportsEffort).toBe(true);
    expect(result[0].effortMap!.minimal).toBe("high");
    expect(result[0].effortMap!.low).toBe("high");
    expect(result[0].effortMap!.medium).toBe("high");
    expect(result[0].effortMap!.high).toBe("high");
    expect(result[0].effortMap!.xhigh).toBe("max");
  });

  test("claude-4.6-opus-thinking — high+max thinking deduped", () => {
    const result = processModels([
      m("claude-4.6-opus-high-thinking"), m("claude-4.6-opus-max-thinking"),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("claude-4.6-opus-thinking");
    expect(result[0].supportsEffort).toBe(true);
    expect(result[0].effortMap!.high).toBe("high");
    expect(result[0].effortMap!.xhigh).toBe("max");
  });

  test("claude-4.5-opus-high — single effort variant, deduped to base", () => {
    const result = processModels([m("claude-4.5-opus-high")]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("claude-4.5-opus");
    expect(result[0].supportsEffort).toBe(true);
    expect(result[0].effortMap!.high).toBe("high");
    expect(result[0].effortMap!.minimal).toBe("high");
  });

  test("claude-4.6-sonnet-medium — single effort variant, deduped to base", () => {
    const result = processModels([m("claude-4.6-sonnet-medium")]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("claude-4.6-sonnet");
    expect(result[0].supportsEffort).toBe(true);
    expect(result[0].effortMap!.medium).toBe("medium");
  });

  test("composer-2 — single model without effort, NOT deduped", () => {
    const result = processModels([m("composer-2")]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("composer-2");
    expect(result[0].supportsEffort).toBe(false);
  });

  test("gpt-5.1-codex-max — deduped, max stays in base name", () => {
    const result = processModels([
      m("gpt-5.1-codex-max-low"), m("gpt-5.1-codex-max-medium"),
      m("gpt-5.1-codex-max-high"), m("gpt-5.1-codex-max-xhigh"),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("gpt-5.1-codex-max");
    expect(result[0].supportsEffort).toBe(true);
  });

  test("gpt-5.3-codex-spark-preview — deduped", () => {
    const result = processModels([
      m("gpt-5.3-codex-spark-preview"), m("gpt-5.3-codex-spark-preview-high"),
      m("gpt-5.3-codex-spark-preview-low"), m("gpt-5.3-codex-spark-preview-xhigh"),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("gpt-5.3-codex-spark-preview");
    expect(result[0].supportsEffort).toBe(true);
  });

  test("standalone models pass through", () => {
    const result = processModels([
      m("default"), m("gemini-3-flash"), m("kimi-k2.5"), m("grok-4-20"), m("grok-4-20-thinking"),
    ]);
    expect(result).toHaveLength(5);
    expect(result.every(r => r.supportsEffort === false)).toBe(true);
  });

  test("uses representative name from medium variant", () => {
    const result = processModels([
      m("gpt-5.4-low", "GPT-5.4 1M Low"),
      m("gpt-5.4-medium", "GPT-5.4 1M"),
      m("gpt-5.4-high", "GPT-5.4 1M High"),
    ]);
    expect(result[0].name).toBe("GPT-5.4 1M");
  });

  test("uses representative name from default (no-suffix) variant", () => {
    const result = processModels([
      m("gpt-5.2", "GPT-5.2"),
      m("gpt-5.2-high", "GPT-5.2 High"),
      m("gpt-5.2-low", "GPT-5.2 Low"),
    ]);
    expect(result[0].name).toBe("GPT-5.2");
  });

  test("full raw model list dedup count", () => {
    const result = processModels(rawModels as CursorModel[]);
    // Should be significantly fewer than 83
    expect(result.length).toBeLessThan(50);
    expect(result.length).toBeGreaterThan(20);

    // Spot checks
    const composer2 = result.find(r => r.id === "composer-2");
    expect(composer2).toBeDefined();
    expect(composer2!.supportsEffort).toBe(false);

    const gpt54 = result.find(r => r.id === "gpt-5.4");
    expect(gpt54).toBeDefined();
    expect(gpt54!.supportsEffort).toBe(true);

    // Opus should be deduped too
    const opus46 = result.find(r => r.id === "claude-4.6-opus");
    expect(opus46).toBeDefined();
    expect(opus46!.supportsEffort).toBe(true);
    expect(result.find(r => r.id === "claude-4.6-opus-high")).toBeUndefined();
    expect(result.find(r => r.id === "claude-4.6-opus-max")).toBeUndefined();

    // No raw effort IDs should leak through for deduped models
    expect(result.find(r => r.id === "gpt-5.4-medium")).toBeUndefined();
    expect(result.find(r => r.id === "gpt-5.4-high")).toBeUndefined();
    expect(result.find(r => r.id === "gpt-5.2-low")).toBeUndefined();
  });
});

// ── resolveModelId ──

describe("resolveModelId", () => {
  test("no effort — returns model as-is", () => {
    expect(resolveModelId("composer-2")).toBe("composer-2");
    expect(resolveModelId("composer-2", undefined)).toBe("composer-2");
    expect(resolveModelId("composer-2", "")).toBe("composer-2");
  });

  test("plain model + effort", () => {
    expect(resolveModelId("gpt-5.4", "medium")).toBe("gpt-5.4-medium");
    expect(resolveModelId("gpt-5.4", "high")).toBe("gpt-5.4-high");
    expect(resolveModelId("gpt-5.4", "xhigh")).toBe("gpt-5.4-xhigh");
  });

  test("fast model + effort — inserts before -fast", () => {
    expect(resolveModelId("gpt-5.4-fast", "medium")).toBe("gpt-5.4-medium-fast");
    expect(resolveModelId("gpt-5.4-fast", "high")).toBe("gpt-5.4-high-fast");
  });

  test("thinking model + effort — inserts before -thinking", () => {
    expect(resolveModelId("claude-4.6-opus-thinking", "high")).toBe("claude-4.6-opus-high-thinking");
    expect(resolveModelId("claude-4.6-opus-thinking", "max")).toBe("claude-4.6-opus-max-thinking");
  });

  test("codex-max model + effort", () => {
    expect(resolveModelId("gpt-5.1-codex-max", "high")).toBe("gpt-5.1-codex-max-high");
    expect(resolveModelId("gpt-5.1-codex-max", "medium")).toBe("gpt-5.1-codex-max-medium");
  });

  test("codex-max-fast model + effort", () => {
    expect(resolveModelId("gpt-5.1-codex-max-fast", "high")).toBe("gpt-5.1-codex-max-high-fast");
  });

  test("spark-preview model + effort", () => {
    expect(resolveModelId("gpt-5.3-codex-spark-preview", "xhigh")).toBe("gpt-5.3-codex-spark-preview-xhigh");
  });
});

// ── Session key derivation ──

const msg = (role: "user" | "assistant" | "system", content: string) => ({ role, content });

describe("deriveBridgeKey", () => {
  test("uses sessionId when provided", () => {
    const msgs = [msg("user", "hello")];
    const a = deriveBridgeKey("gpt-5", msgs, "session-abc");
    const b = deriveBridgeKey("gpt-5", msgs, "session-abc");
    expect(a).toBe(b);
  });

  test("different sessionIds produce different keys", () => {
    const msgs = [msg("user", "hello")];
    const a = deriveBridgeKey("gpt-5", msgs, "session-1");
    const b = deriveBridgeKey("gpt-5", msgs, "session-2");
    expect(a).not.toBe(b);
  });

  test("different models produce different keys", () => {
    const msgs = [msg("user", "hello")];
    const a = deriveBridgeKey("gpt-5", msgs, "session-1");
    const b = deriveBridgeKey("claude-4", msgs, "session-1");
    expect(a).not.toBe(b);
  });

  test("falls back to first user message hash without sessionId", () => {
    const msgs1 = [msg("user", "hello")];
    const msgs2 = [msg("user", "hello"), msg("assistant", "hi"), msg("user", "bye")];
    // Same first user message → same key
    expect(deriveBridgeKey("gpt-5", msgs1)).toBe(deriveBridgeKey("gpt-5", msgs2));
  });

  test("fallback differs by first user message", () => {
    const a = deriveBridgeKey("gpt-5", [msg("user", "hello")]);
    const b = deriveBridgeKey("gpt-5", [msg("user", "goodbye")]);
    expect(a).not.toBe(b);
  });
});

describe("deriveConversationKey", () => {
  test("same sessionId → same key regardless of messages", () => {
    const a = deriveConversationKey([msg("user", "hello")], "session-x");
    const b = deriveConversationKey([msg("user", "totally different")], "session-x");
    expect(a).toBe(b);
  });

  test("different sessionIds → different keys", () => {
    const a = deriveConversationKey([msg("user", "hello")], "session-1");
    const b = deriveConversationKey([msg("user", "hello")], "session-2");
    expect(a).not.toBe(b);
  });

  test("falls back to first user message hash without sessionId", () => {
    const a = deriveConversationKey([msg("user", "hello")]);
    const b = deriveConversationKey([msg("user", "hello"), msg("assistant", "hi")]);
    expect(a).toBe(b);
  });
});

// ── Fork detection ──

function makeStored(overrides: Partial<StoredConversation> = {}): StoredConversation {
  return {
    conversationId: "conv-original",
    checkpoint: new Uint8Array([1, 2, 3]),
    checkpointTurnCount: 1,
    blobStore: new Map([["key", new Uint8Array([4, 5])]]),
    lastAccessMs: Date.now(),
    ...overrides,
  };
}

describe("detectForkAndInvalidate", () => {
  test("no fork — turn count matches checkpoint", () => {
    const stored = makeStored({ checkpointTurnCount: 2 });
    const originalId = stored.conversationId;
    const result = detectForkAndInvalidate(stored, 2, "conv-key");
    expect(result).toBe(false);
    expect(stored.checkpoint).not.toBeNull();
    expect(stored.conversationId).toBe(originalId);
    expect(stored.blobStore.size).toBe(1);
  });

  test("no checkpoint — nothing to invalidate", () => {
    const stored = makeStored({ checkpoint: null, checkpointTurnCount: 5 });
    const originalId = stored.conversationId;
    const result = detectForkAndInvalidate(stored, 0, "conv-key");
    expect(result).toBe(false);
    expect(stored.conversationId).toBe(originalId);
  });

  test("fork detected — checkpoint discarded, new conversation ID", () => {
    const stored = makeStored({ checkpointTurnCount: 3 });
    const originalId = stored.conversationId;
    const result = detectForkAndInvalidate(stored, 1, "conv-key");
    expect(result).toBe(true);
    expect(stored.checkpoint).toBeNull();
    expect(stored.checkpointTurnCount).toBe(0);
    expect(stored.conversationId).not.toBe(originalId);
    // Blob store preserved (has system prompt blob)
    expect(stored.blobStore.size).toBe(1);
  });

  test("fork to beginning — checkpoint discarded", () => {
    const stored = makeStored({ checkpointTurnCount: 3 });
    const originalId = stored.conversationId;
    const result = detectForkAndInvalidate(stored, 0, "conv-key");
    expect(result).toBe(true);
    expect(stored.checkpoint).toBeNull();
    expect(stored.checkpointTurnCount).toBe(0);
    expect(stored.conversationId).not.toBe(originalId);
  });

  test("fork detected — more turns than checkpoint", () => {
    const stored = makeStored({ checkpointTurnCount: 1 });
    const result = detectForkAndInvalidate(stored, 5, "conv-key");
    expect(result).toBe(true);
    expect(stored.checkpoint).toBeNull();
    expect(stored.checkpointTurnCount).toBe(0);
    // Blob store preserved
    expect(stored.blobStore.size).toBe(1);
  });

  test("fork preserves blob store", () => {
    const stored = makeStored({ checkpointTurnCount: 3 });
    stored.blobStore.set("system-prompt", new Uint8Array([1, 2, 3]));
    detectForkAndInvalidate(stored, 1, "conv-key");
    expect(stored.blobStore.has("key")).toBe(true);
    expect(stored.blobStore.has("system-prompt")).toBe(true);
  });
});

describe("session + fork integration", () => {
  test("normal conversation flow — checkpoint reused across turns", () => {
    const convKey = deriveConversationKey([], "session-A");
    const stored = makeStored({ checkpoint: null, checkpointTurnCount: 0, blobStore: new Map() });

    // No checkpoint → no fork detection
    expect(detectForkAndInvalidate(stored, 0, convKey)).toBe(false);

    // Simulate checkpoint saved after request 1
    stored.checkpoint = new Uint8Array([10]);
    stored.checkpointTurnCount = 1;

    // Request 2: turns.length=1 matches checkpointTurnCount=1
    expect(detectForkAndInvalidate(stored, 1, convKey)).toBe(false);
    expect(stored.checkpoint).not.toBeNull();

    // Checkpoint saved after request 2
    stored.checkpoint = new Uint8Array([20]);
    stored.checkpointTurnCount = 2;

    // Request 3: turns.length=2 matches checkpointTurnCount=2
    expect(detectForkAndInvalidate(stored, 2, convKey)).toBe(false);
    expect(stored.checkpoint).not.toBeNull();
  });

  test("fork after turn 1 — checkpoint discarded, conversation rebuilt from turns", () => {
    const convKey = deriveConversationKey([], "session-B");
    const stored = makeStored({ checkpointTurnCount: 2 });
    const originalId = stored.conversationId;

    // Fork: turns.length=1, checkpointTurnCount=2
    expect(detectForkAndInvalidate(stored, 1, convKey)).toBe(true);
    expect(stored.checkpoint).toBeNull();
    expect(stored.checkpointTurnCount).toBe(0);
    expect(stored.conversationId).not.toBe(originalId);
    // Blob store preserved for conversation init
    expect(stored.blobStore.size).toBe(1);
  });

  test("fork to beginning — checkpoint discarded", () => {
    const convKey = deriveConversationKey([], "session-C");
    const stored = makeStored({ checkpointTurnCount: 3 });
    const originalId = stored.conversationId;

    expect(detectForkAndInvalidate(stored, 0, convKey)).toBe(true);
    expect(stored.checkpoint).toBeNull();
    expect(stored.conversationId).not.toBe(originalId);
  });

  test("same session ID used for convKey across fork", () => {
    const keyBefore = deriveConversationKey([msg("user", "test"), msg("assistant", "ok"), msg("user", "test 2")], "session-D");
    const keyAfter = deriveConversationKey([msg("user", "test"), msg("assistant", "ok"), msg("user", "test 22")], "session-D");
    expect(keyBefore).toBe(keyAfter);
  });
});

// ── Conversation history inlining ──

describe("inlineConversationHistory", () => {
  test("prepends turns as XML to user message", () => {
    const turns = [
      { userText: 'respond "543"', assistantText: "543" },
    ];
    const result = inlineConversationHistory(turns, "whats my last user message?");
    expect(result).toContain("<conversation_history>");
    expect(result).toContain('respond "543"');
    expect(result).toContain("543");
    expect(result).toContain("</conversation_history>");
    expect(result).toEndWith("whats my last user message?");
  });

  test("multiple turns in order", () => {
    const turns = [
      { userText: "first", assistantText: "resp1" },
      { userText: "second", assistantText: "resp2" },
    ];
    const result = inlineConversationHistory(turns, "current");
    const firstIdx = result.indexOf("first");
    const secondIdx = result.indexOf("second");
    const currentIdx = result.indexOf("current");
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(currentIdx);
  });

  test("no turns returns userText unchanged", () => {
    // This path shouldn't be called with empty turns, but verify it's safe
    const result = inlineConversationHistory([], "hello");
    expect(result).toContain("hello");
  });
});

// ── Fork → inline history integration ──

describe("fork inlines history into user message", () => {
  test("fork discards checkpoint, then history is inlined", () => {
    // Simulate: 2-turn conversation, fork back to 1 turn
    const convKey = deriveConversationKey([], "session-F");
    const stored = makeStored({ checkpointTurnCount: 2 });

    // Fork detected: incoming turns=1, checkpoint covers 2
    const forked = detectForkAndInvalidate(stored, 1, convKey);
    expect(forked).toBe(true);
    expect(stored.checkpoint).toBeNull();

    // Now simulate what buildCursorRequest does:
    // if (!checkpoint && turns.length > 0) → inline history
    const turns = [{ userText: 'respond "543"', assistantText: "543" }];
    const userText = "whats my last user message?";
    const checkpoint = stored.checkpoint; // null after fork

    let effectiveUserText = userText;
    if (!checkpoint && turns.length > 0) {
      effectiveUserText = inlineConversationHistory(turns, userText);
    }

    expect(effectiveUserText).toContain("<conversation_history>");
    expect(effectiveUserText).toContain('respond "543"');
    expect(effectiveUserText).toContain("543");
    expect(effectiveUserText).toEndWith("whats my last user message?");
  });

  test("no fork — checkpoint exists, history NOT inlined", () => {
    const convKey = deriveConversationKey([], "session-G");
    const stored = makeStored({ checkpointTurnCount: 1 });

    // No fork: incoming turns=1 matches checkpoint
    const forked = detectForkAndInvalidate(stored, 1, convKey);
    expect(forked).toBe(false);

    const turns = [{ userText: 'respond "543"', assistantText: "543" }];
    const userText = "whats my last user message?";
    const checkpoint = stored.checkpoint; // still set

    let effectiveUserText = userText;
    if (!checkpoint && turns.length > 0) {
      effectiveUserText = inlineConversationHistory(turns, userText);
    }

    // User text unchanged — history is in the checkpoint, not inlined
    expect(effectiveUserText).toBe(userText);
  });

  test("first message (no checkpoint, no turns) — not inlined", () => {
    const userText = "hello";
    const checkpoint = null;
    const turns: Array<{ userText: string; assistantText: string }> = [];

    let effectiveUserText = userText;
    if (!checkpoint && turns.length > 0) {
      effectiveUserText = inlineConversationHistory(turns, userText);
    }

    expect(effectiveUserText).toBe("hello");
  });
});
