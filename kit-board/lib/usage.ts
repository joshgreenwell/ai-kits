type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function textValue(value: unknown, label: string, maxLength = 160): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`${label} is invalid`);
  }
  return value.trim();
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return Math.round(value);
}

function subagentTokens(current: JsonObject): number {
  const modes = Array.isArray(current.by_work_mode) ? current.by_work_mode : [];
  const row = modes.find((item) => {
    return object(item, "work mode").key === "Subagents";
  });
  return row ? numberValue(object(row, "subagent work mode").total_tokens, "subagent tokens") : 0;
}

export function parseLegacyEnvelope(payload: unknown) {
  const envelope = object(payload, "payload");
  const report = object(envelope.report, "report");
  const current = object(report.current, "report.current");
  const totals = object(current.totals, "report.current.totals");
  const composition = object(
    current.exclusive_composition,
    "report.current.exclusive_composition",
  );
  const ratios = object(current.ratios, "report.current.ratios");
  const orchestration = object(
    current.agent_orchestration,
    "report.current.agent_orchestration",
  );
  const spawns = object(orchestration.spawns, "agent spawns");
  const brain = object(current.knowledge_brain, "knowledge brain");
  const month = textValue(current.month, "month", 7);
  const machineId = textValue(envelope.machine_id, "machine_id", 80);
  const machineName = textValue(envelope.machine_name, "machine_name", 120);
  const collection = report.collection ? object(report.collection, "report.collection") : null;
  const periodState = collection?.kind === 'hourly_detailed_report' ? collection.period_state : null;
  if (periodState !== null && periodState !== 'partial' && periodState !== 'complete') throw new Error('Invalid detailed report period state');

  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("month must use YYYY-MM");
  if (!/^[a-zA-Z0-9._-]+$/.test(machineId)) {
    throw new Error("machine_id may contain only letters, numbers, dots, dashes, and underscores");
  }

  const rawTokens = numberValue(totals.total_tokens, "total tokens");
  const cachedInputTokens = numberValue(
    composition.cached_input_tokens,
    "cached input tokens",
  );
  const customShare = Number(ratios.custom_agent_share_of_total ?? 0);

  return {
    machineId,
    machineName,
    month,
    periodState,
    schemaVersion: numberValue(envelope.schema_version ?? 1, "schema version"),
    generatedAt: textValue(report.generated_at_local, "generated_at_local", 80),
    rawTokens,
    freshTokens: numberValue(
      totals.fresh_non_cached_tokens ?? rawTokens - cachedInputTokens,
      "fresh tokens",
    ),
    cachedInputTokens,
    modelCalls: numberValue(totals.calls, "model calls"),
    threadCount: numberValue(totals.threads, "thread count"),
    agentSpawns: numberValue(spawns.total, "agent spawns"),
    customAgentSpawns: numberValue(spawns.custom, "custom agent spawns"),
    subagentTokens: subagentTokens(current),
    customAgentTokens: Number.isFinite(customShare)
      ? Math.round(rawTokens * Math.max(0, customShare))
      : 0,
    gameDesignTokens: numberValue(brain.game_design_tokens, "game-design tokens"),
    directBrainCalls: numberValue(brain.direct_tool_calls, "direct brain calls"),
    reportJson: JSON.stringify(envelope),
  };
}
