// src/messaging/sampling.ts — MCP sampling helper with graceful degradation

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface AskLLMOptions {
  maxTokens?: number;
}

/**
 * Request LLM sampling from the connected client.
 * Returns null if the client doesn't support sampling — tools should
 * fall back to template-based responses in that case.
 */
export async function askLLM(
  server: McpServer,
  systemPrompt: string,
  userMessage: string,
  options?: AskLLMOptions,
): Promise<string | null> {
  try {
    const result = await server.server.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: userMessage } }],
      systemPrompt,
      maxTokens: options?.maxTokens ?? 1024,
    });
    return result.content.type === 'text' ? result.content.text : null;
  } catch {
    // Client doesn't support sampling — degrade gracefully
    return null;
  }
}
