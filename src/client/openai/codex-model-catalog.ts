import type { ModelConfig, ThinkingEffort } from '../../types';
import { reasoningEffort, verbosity } from '../../well-known/preset-templates';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isThinkingEffort(value: unknown): value is ThinkingEffort {
  return value === 'none' || value === 'minimal' || value === 'low' ||
    value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max';
}

function isVerbosity(value: unknown): value is NonNullable<ModelConfig['verbosity']> {
  return value === 'low' || value === 'medium' || value === 'high';
}

function promptBudget(item: Record<string, unknown>): number {
  // max_context_window is an override ceiling, not the default when one exists.
  const window = item['context_window'] ?? item['max_context_window'];
  if (typeof window !== 'number' || !Number.isSafeInteger(window) || window <= 0) {
    throw new Error('Invalid Codex model catalog: missing a valid context window.');
  }
  const percent = item['effective_context_window_percent'] ?? 95;
  if (typeof percent !== 'number' || !Number.isInteger(percent) || percent <= 0 || percent > 100) {
    throw new Error('Invalid Codex model catalog: invalid effective context percentage.');
  }
  // The CLI percentage reserves system/tool/output space; keep at least its 5% default.
  const budget = Math.floor((window / 100) * Math.min(percent, 95));
  if (!Number.isSafeInteger(budget) || budget <= 0) {
    throw new Error('Invalid Codex model catalog: invalid prompt budget.');
  }
  return budget;
}

/** Maps the authenticated ChatGPT catalog; public API eligibility is independent. */
export function parseCodexModelCatalog(raw: unknown): ModelConfig[] {
  if (!isRecord(raw) || !Array.isArray(raw['models'])) {
    throw new Error('Invalid Codex model catalog: expected a models array.');
  }
  const result: ModelConfig[] = [];
  const seen = new Set<string>();
  for (const item of raw['models']) {
    if (!isRecord(item)) {
      throw new Error('Invalid Codex model catalog: invalid model entry.');
    }
    const visibility = item['visibility'];
    if (visibility !== 'list' && visibility !== 'hide' && visibility !== 'none') {
      throw new Error('Invalid Codex model catalog: invalid model visibility.');
    }
    if (visibility !== 'list') continue;
    const slug = item['slug'];
    if (typeof slug !== 'string' || !slug.trim()) {
      throw new Error('Invalid Codex model catalog: missing a model identifier.');
    }
    const id = slug.trim();
    if (seen.has(id)) continue;
    seen.add(id);

    const levels: ThinkingEffort[] = [];
    const advertised = item['supported_reasoning_levels'];
    if (Array.isArray(advertised)) {
      for (const level of advertised) {
        const effort = isRecord(level) ? level['effort'] : undefined;
        if (isThinkingEffort(effort) && !levels.includes(effort)) levels.push(effort);
      }
    }
    const requestedDefault = item['default_reasoning_level'];
    const defaultEffort = isThinkingEffort(requestedDefault) && levels.includes(requestedDefault)
      ? requestedDefault
      : levels.includes('medium') ? 'medium' : levels[0];
    const summary = item['default_reasoning_summary'];
    const summaryEnabled = item['supports_reasoning_summary_parameter'] !== false &&
      item['supports_reasoning_summaries'] !== false;
    const defaultSummary = !summaryEnabled ? 'none'
      : summary === 'none' || summary === 'auto' || summary === 'concise' || summary === 'detailed'
        ? summary : 'auto';
    const supportsVerbosity = item['support_verbosity'] === true;
    const defaultVerbosity = supportsVerbosity && isVerbosity(item['default_verbosity'])
      ? item['default_verbosity'] : undefined;
    const modalities = item['input_modalities'];
    if (modalities !== undefined && modalities !== null && !Array.isArray(modalities)) {
      throw new Error('Invalid Codex model catalog: invalid input modalities.');
    }
    const patchType = item['apply_patch_tool_type'];
    const name = item['display_name'];
    result.push({
      id,
      ...(typeof name === 'string' && name.trim() ? { name: name.trim() } : {}),
      maxInputTokens: promptBudget(item),
      // Codex controls generation limits; clear the public catalog's output default.
      maxOutputTokens: undefined,
      thinking: defaultEffort === undefined ? undefined : {
        type: defaultEffort === 'none' ? 'disabled' : 'enabled',
        effort: defaultEffort,
        summary: defaultSummary,
      },
      capabilities: {
        // Codex is an agent backend; edit-tool selection is a client preference.
        toolCalling: true,
        imageInput: modalities === undefined || modalities === null || modalities.includes('image'),
        editTools: patchType === 'freeform' || patchType === 'function'
          ? 'apply-patch' : 'multi-find-replace',
      },
      parallelToolCalling: typeof item['supports_parallel_tool_calls'] === 'boolean'
        ? item['supports_parallel_tool_calls'] : undefined,
      verbosity: defaultVerbosity,
      presetTemplates: [
        ...(levels.length ? [reasoningEffort({ supported: levels, default: defaultEffort })] : []),
        ...(supportsVerbosity
          ? [{ ...verbosity(), ...(defaultVerbosity ? { default: defaultVerbosity } : {}) }]
          : []),
      ],
    });
  }
  return result;
}
