import type { ClientOptions } from "@anthropic-ai/sdk";
import { Anthropic as SDKAnthropic } from "@anthropic-ai/sdk";
import type {
  Tool,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta/tools/messages";
import type { TextBlock } from "@anthropic-ai/sdk/resources/index";
import { getEnv } from "@llamaindex/env";
import _ from "lodash";
import type { BaseTool } from "../types.js";
import { BaseLLM } from "./base.js";
import type {
  ChatMessage,
  ChatResponse,
  ChatResponseChunk,
  LLMChatParamsNonStreaming,
  LLMChatParamsStreaming,
} from "./types.js";
import { extractText, wrapLLMEvent } from "./utils.js";

export class AnthropicSession {
  anthropic: SDKAnthropic;

  constructor(options: ClientOptions = {}) {
    if (!options.apiKey) {
      options.apiKey = getEnv("ANTHROPIC_API_KEY");
    }

    if (!options.apiKey) {
      throw new Error("Set Anthropic Key in ANTHROPIC_API_KEY env variable");
    }

    this.anthropic = new SDKAnthropic(options);
  }
}

// I'm not 100% sure this is necessary vs. just starting a new session
// every time we make a call. They say they try to reuse connections
// so in theory this is more efficient, but we should test it in the future.
const defaultAnthropicSession: {
  session: AnthropicSession;
  options: ClientOptions;
}[] = [];

/**
 * Get a session for the Anthropic API. If one already exists with the same options,
 * it will be returned. Otherwise, a new session will be created.
 * @param options
 * @returns
 */
export function getAnthropicSession(options: ClientOptions = {}) {
  let session = defaultAnthropicSession.find((session) => {
    return _.isEqual(session.options, options);
  })?.session;

  if (!session) {
    session = new AnthropicSession(options);
    defaultAnthropicSession.push({ session, options });
  }

  return session;
}

export const ALL_AVAILABLE_ANTHROPIC_LEGACY_MODELS = {
  "claude-2.1": {
    contextWindow: 200000,
  },
  "claude-instant-1.2": {
    contextWindow: 100000,
  },
};

export const ALL_AVAILABLE_V3_MODELS = {
  "claude-3-opus": { contextWindow: 200000 },
  "claude-3-sonnet": { contextWindow: 200000 },
  "claude-3-haiku": { contextWindow: 200000 },
};

export const ALL_AVAILABLE_ANTHROPIC_MODELS = {
  ...ALL_AVAILABLE_ANTHROPIC_LEGACY_MODELS,
  ...ALL_AVAILABLE_V3_MODELS,
};

const AVAILABLE_ANTHROPIC_MODELS_WITHOUT_DATE: { [key: string]: string } = {
  "claude-3-opus": "claude-3-opus-20240229",
  "claude-3-sonnet": "claude-3-sonnet-20240229",
  "claude-3-haiku": "claude-3-haiku-20240307",
} as { [key in keyof typeof ALL_AVAILABLE_ANTHROPIC_MODELS]: string };

export type AnthropicAdditionalChatOptions = {};

export type AnthropicAdditionalMessageOptions =
  | {
      toolCall: string;
    }
  | {
      toolUse: ToolUseBlock;
    }
  | {};

export class Anthropic extends BaseLLM<
  AnthropicAdditionalChatOptions,
  AnthropicAdditionalMessageOptions
> {
  // Per completion Anthropic params
  model: keyof typeof ALL_AVAILABLE_ANTHROPIC_MODELS;
  temperature: number;
  topP: number;
  maxTokens?: number;

  // Anthropic session params
  apiKey?: string = undefined;
  maxRetries: number;
  timeout?: number;
  session: AnthropicSession;

  constructor(init?: Partial<Anthropic>) {
    super();
    this.model = init?.model ?? "claude-3-opus";
    this.temperature = init?.temperature ?? 0.1;
    this.topP = init?.topP ?? 0.999; // Per Ben Mann
    this.maxTokens = init?.maxTokens ?? undefined;

    this.apiKey = init?.apiKey ?? undefined;
    this.maxRetries = init?.maxRetries ?? 10;
    this.timeout = init?.timeout ?? 60 * 1000; // Default is 60 seconds
    this.session =
      init?.session ??
      getAnthropicSession({
        apiKey: this.apiKey,
        maxRetries: this.maxRetries,
        timeout: this.timeout,
      });
  }

  get metadata() {
    return {
      model: this.model,
      temperature: this.temperature,
      topP: this.topP,
      maxTokens: this.maxTokens,
      contextWindow: ALL_AVAILABLE_ANTHROPIC_MODELS[this.model].contextWindow,
      tokenizer: undefined,
    };
  }

  getModelName = (model: string): string => {
    if (Object.keys(AVAILABLE_ANTHROPIC_MODELS_WITHOUT_DATE).includes(model)) {
      return AVAILABLE_ANTHROPIC_MODELS_WITHOUT_DATE[model];
    }
    return model;
  };

  formatMessages(messages: ChatMessage[]) {
    return messages.map((message) => {
      if (message.role !== "user" && message.role !== "assistant") {
        throw new Error("Unsupported Anthropic role");
      }

      return {
        content: extractText(message.content),
        role: message.role,
      };
    });
  }

  chat(
    params: LLMChatParamsStreaming,
  ): Promise<AsyncIterable<ChatResponseChunk>>;
  chat(params: LLMChatParamsNonStreaming): Promise<ChatResponse>;
  @wrapLLMEvent
  async chat(
    params: LLMChatParamsNonStreaming | LLMChatParamsStreaming,
  ): Promise<ChatResponse | AsyncIterable<ChatResponseChunk>> {
    let { messages } = params;

    const { stream, tools } = params;

    let systemPrompt: string | null = null;

    const systemMessages = messages.filter(
      (message) => message.role === "system",
    );

    if (systemMessages.length > 0) {
      systemPrompt = systemMessages
        .map((message) => message.content)
        .join("\n");
      messages = messages.filter((message) => message.role !== "system");
    }

    // case: Streaming
    if (stream) {
      if (tools) {
        console.error("Tools are not supported in streaming mode");
      }
      return this.streamChat(messages, systemPrompt);
    }
    // case: Non-streaming
    const anthropic = this.session.anthropic;

    if (tools) {
      const response = await anthropic.beta.tools.messages.create({
        messages: this.formatMessages(messages),
        tools: tools.map(Anthropic.toTool),
        model: this.getModelName(this.model),
        temperature: this.temperature,
        max_tokens: this.maxTokens ?? 4096,
        top_p: this.topP,
        ...(systemPrompt && { system: systemPrompt }),
      });

      const toolUseBlock = response.content.find(
        (content): content is ToolUseBlock => content.type === "tool_use",
      );

      return {
        raw: response,
        message: {
          content: response.content
            .filter((content): content is TextBlock => content.type === "text")
            .map((content) => ({
              type: "text",
              text: content.text,
            })),
          role: "assistant",
          options: toolUseBlock
            ? {
                toolUse: toolUseBlock,
              }
            : {},
        },
      };
    } else {
      const response = await anthropic.messages.create({
        model: this.getModelName(this.model),
        messages: this.formatMessages(messages),
        max_tokens: this.maxTokens ?? 4096,
        temperature: this.temperature,
        top_p: this.topP,
        ...(systemPrompt && { system: systemPrompt }),
      });

      return {
        raw: response,
        message: { content: response.content[0].text, role: "assistant" },
      };
    }
  }

  protected async *streamChat(
    messages: ChatMessage[],
    systemPrompt?: string | null,
  ): AsyncIterable<ChatResponseChunk> {
    const stream = await this.session.anthropic.messages.create({
      model: this.getModelName(this.model),
      messages: this.formatMessages(messages),
      max_tokens: this.maxTokens ?? 4096,
      temperature: this.temperature,
      top_p: this.topP,
      stream: true,
      ...(systemPrompt && { system: systemPrompt }),
    });

    let idx_counter: number = 0;
    for await (const part of stream) {
      const content =
        part.type === "content_block_delta" ? part.delta.text : null;

      if (typeof content !== "string") continue;

      idx_counter++;
      yield {
        raw: part,
        delta: content,
      };
    }
    return;
  }

  static toTool(tool: BaseTool): Tool {
    if (tool.metadata.parameters?.type !== "object") {
      throw new TypeError("Tool parameters must be an object");
    }
    return {
      input_schema: {
        type: "object",
        properties: tool.metadata.parameters.properties,
        required: tool.metadata.parameters.required,
      },
      name: tool.metadata.name,
      description: tool.metadata.description,
    };
  }
}
