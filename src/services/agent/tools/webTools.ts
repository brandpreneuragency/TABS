// ---------------------------------------------------------------------------
// TABS Work-OS Harness — Model-selected web search tool
// Runs only when the model selects it and policy allows network_read.
// Never injects search results before a message. Secrets stay out of results.
// ---------------------------------------------------------------------------

import type { AgentToolDefinition, AgentToolResult, ToolExecutionContext } from '../../../types/agent';
import type { SearchResult } from '../../../types';
import { readSearchCredentials } from '../credentialMigration';
import { redactSecrets } from '../redaction';
import {
  asRecord,
  cancelled,
  defineCodingTool,
  fail,
  objectSchema,
  WEB_SEARCH_TIMEOUT_MS,
  WEB_TOOL_NAMES,
} from './codingSupport';

export { WEB_TOOL_NAMES };

export type WebSearchProvider = 'tavily' | 'exa';

export interface WebSearchHit {
  title: string;
  url: string;
  excerpt: string;
}

export interface WebToolDependencies {
  search?: (input: {
    query: string;
    provider: WebSearchProvider;
    maxResults: number;
  }) => Promise<WebSearchHit[]>;
  isDesktop?: () => boolean;
}

const PROVIDERS: WebSearchProvider[] = ['tavily', 'exa'];

function isProvider(value: unknown): value is WebSearchProvider {
  return value === 'tavily' || value === 'exa';
}

async function defaultSearch(input: {
  query: string;
  provider: WebSearchProvider;
  maxResults: number;
}): Promise<WebSearchHit[]> {
  const credentials = await readSearchCredentials();
  const { invokeWebSearch } = await import('../../search');
  const results: SearchResult[] = await invokeWebSearch(input.query, {
    exaKey: credentials.exaKey,
    tavilyKey: credentials.tavilyKey,
    searchProvider: input.provider,
  });
  return results.slice(0, input.maxResults).map((result) => ({
    title: redactSecrets(result.title),
    url: result.url,
    excerpt: redactSecrets(result.snippet),
  }));
}

export function createWebTools(deps: WebToolDependencies = {}): AgentToolDefinition[] {
  const search = deps.search ?? defaultSearch;

  const webSearch = defineCodingTool({
    name: 'web_search',
    description: 'Search the web when the model needs current data. Requires a network policy grant.',
    risk: 'network_read',
    sideEffect: 'none',
    supportsRetry: true,
    timeoutMs: WEB_SEARCH_TIMEOUT_MS,
    inputSchema: objectSchema({
      query: { type: 'string', minLength: 1 },
      provider: { type: 'string', enum: PROVIDERS },
      maxResults: { type: 'integer', minimum: 1, maximum: 10 },
    }, ['query', 'provider', 'maxResults']),
    normalizeArgs: (args) => {
      const record = asRecord(args);
      const maxResults = typeof record.maxResults === 'number' ? Math.min(Math.max(record.maxResults, 1), 10) : 5;
      return {
        query: String(record.query ?? '').trim(),
        provider: record.provider,
        maxResults,
      };
    },
    resolveResourceKeys: (_context, args) => [`web:${String(asRecord(args).provider ?? 'tavily')}`],
    buildEffectPayload: (args) => ({
      tool: 'web_search',
      query: asRecord(args).query,
      provider: asRecord(args).provider,
    }),
    async execute(context: ToolExecutionContext, args: unknown): Promise<AgentToolResult> {
      if (context.abortSignal.aborted) return cancelled('web_search');
      const record = asRecord(args);
      const query = String(record.query ?? '').trim();
      const provider = record.provider;
      const maxResults = typeof record.maxResults === 'number' ? record.maxResults : 5;
      if (!query) return fail('validation_failed', 'query must be non-empty');
      if (!isProvider(provider)) return fail('validation_failed', 'provider must be tavily or exa');
      try {
        const hits = await search({ query, provider, maxResults });
        if (context.abortSignal.aborted) return cancelled('web_search');
        return {
          ok: true,
          summary: `Found ${hits.length} results from ${provider}`,
          data: {
            query,
            provider,
            results: hits.map((hit) => ({
              title: redactSecrets(hit.title),
              url: hit.url,
              excerpt: redactSecrets(hit.excerpt),
            })),
            providerMetadata: { provider, maxResults },
          },
        };
      } catch (caught) {
        const message = redactSecrets(caught instanceof Error ? caught.message : 'Web search failed');
        if (/rate limit|429/i.test(message)) {
          return { ok: false, summary: message, error: { code: 'rate_limited', message, retryable: true } };
        }
        if (/not configured|no search api key|empty/i.test(message)) {
          return fail('unavailable', message);
        }
        return fail('internal_error', message);
      }
    },
  });

  return [webSearch];
}
