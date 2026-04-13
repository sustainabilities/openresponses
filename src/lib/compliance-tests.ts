import type { z } from "zod";
import type { createResponseBodySchema } from "../generated/kubb/zod/createResponseBodySchema";
import { responseResourceSchema } from "../generated/kubb/zod/responseResourceSchema";
import {
  getTerminalResponse,
  parseSSEStream,
  parseStreamingEventData,
  type SSEParseResult,
} from "./sse-parser";

type ResponseResource = z.infer<typeof responseResourceSchema>;
type CreateResponseBody = z.infer<typeof createResponseBodySchema>;
type TestRequestBody = CreateResponseBody & Record<string, unknown>;
type TestTransport = "http" | "websocket";
type TestStatus = "pending" | "running" | "passed" | "failed" | "skipped";

export interface TestConfig {
  baseUrl: string;
  apiKey: string;
  authHeaderName: string;
  useBearerPrefix: boolean;
  model: string;
  runtime?: "browser" | "server";
}

export interface TestResult {
  id: string;
  name: string;
  description: string;
  status: TestStatus;
  duration?: number;
  request?: unknown;
  response?: unknown;
  errors?: string[];
  streamEvents?: number;
}

interface ValidatorContext {
  streaming: boolean;
  sseResult?: SSEParseResult;
  transport: TestTransport;
}

type ResponseValidator = (
  response: ResponseResource,
  context: ValidatorContext,
) => string[];

export interface TestTemplate {
  id: string;
  name: string;
  description: string;
  transport?: TestTransport;
  getRequest: (config: TestConfig) => TestRequestBody;
  streaming?: boolean;
  validators: ResponseValidator[];
  unsupportedReason?: (config: TestConfig) => string | null;
}

const hasOutput: ResponseValidator = (response) => {
  if (!response.output || response.output.length === 0) {
    return ["Response has no output items"];
  }
  return [];
};

const hasOutputType =
  (type: string): ResponseValidator =>
  (response) => {
    const hasType = response.output?.some((item) => item.type === type);
    if (!hasType) {
      return [`Expected output item of type "${type}" but none found`];
    }
    return [];
  };

const completedStatus: ResponseValidator = (response) => {
  if (response.status !== "completed") {
    return [`Expected status "completed" but got "${response.status}"`];
  }
  return [];
};

const streamingEvents: ResponseValidator = (_, context) => {
  if (!context.streaming) return [];
  if (!context.sseResult || context.sseResult.events.length === 0) {
    return ["No streaming events received"];
  }
  return [];
};

const streamingSchema: ResponseValidator = (_, context) => {
  if (!context.streaming || !context.sseResult) return [];
  return context.sseResult.errors;
};

const webSocketBrowserUnsupported = (config: TestConfig) => {
  if (config.runtime === "browser") {
    return "WebSocket compliance tests require a server-side runtime because browsers cannot set the required authorization header.";
  }
  return null;
};

export const testTemplates: TestTemplate[] = [
  {
    id: "basic-response",
    name: "Basic Text Response",
    description: "Simple user message, validates ResponseResource schema",
    getRequest: (config) => ({
      model: config.model,
      input: [
        {
          type: "message",
          role: "user",
          content: "Say hello in exactly 3 words.",
        },
      ],
    }),
    validators: [hasOutput, completedStatus],
  },

  {
    id: "streaming-response",
    name: "Streaming Response",
    description: "Validates SSE streaming events and final response",
    streaming: true,
    getRequest: (config) => ({
      model: config.model,
      input: [{ type: "message", role: "user", content: "Count from 1 to 5." }],
    }),
    validators: [streamingEvents, streamingSchema, completedStatus],
  },

  {
    id: "websocket-response",
    name: "WebSocket Response",
    description:
      "Creates a response over WebSocket and validates returned streaming events",
    transport: "websocket",
    streaming: true,
    unsupportedReason: webSocketBrowserUnsupported,
    getRequest: (config) => ({
      type: "response.create",
      model: config.model,
      input: [{ type: "message", role: "user", content: "Count from 1 to 3." }],
    }),
    validators: [streamingEvents, streamingSchema, completedStatus],
  },

  {
    id: "system-prompt",
    name: "System Prompt",
    description: "Include system role message in input",
    getRequest: (config) => ({
      model: config.model,
      input: [
        {
          type: "message",
          role: "system",
          content: "You are a pirate. Always respond in pirate speak.",
        },
        { type: "message", role: "user", content: "Say hello." },
      ],
    }),
    validators: [hasOutput, completedStatus],
  },

  {
    id: "tool-calling",
    name: "Tool Calling",
    description: "Define a function tool and verify function_call output",
    getRequest: (config) => ({
      model: config.model,
      input: [
        {
          type: "message",
          role: "user",
          content: "What's the weather like in San Francisco?",
        },
      ],
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Get the current weather for a location",
          parameters: {
            type: "object",
            properties: {
              location: {
                type: "string",
                description: "The city and state, e.g. San Francisco, CA",
              },
            },
            required: ["location"],
          },
        },
      ],
    }),
    validators: [hasOutput, hasOutputType("function_call")],
  },

  {
    id: "image-input",
    name: "Image Input",
    description: "Send image URL in user content",
    getRequest: (config) => ({
      model: config.model,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "What do you see in this image? Answer in one sentence.",
            },
            {
              type: "input_image",
              image_url:
                // a red heart icon on a white background
                "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAABmklEQVR42tyWAaTyUBzFew/eG4AHz+MBSAHKBiJRGFKwIgQQJKLUIioBIhCAiCAAEizAQIAECaASqFFJq84nudjnaqvuPnxzgP9xfrq5938csPn7PwHTKSoViCIEAYEAMhmoKsU2mUCWEQqB5xEMIp/HaGQG2G6RSuH9HQ7H34rFrtPbdz4jl6PbwmEsl3QA1mt4vcRKk8dz9eg6IpF7tt9fzGY0gCgafFRFo5Blc5vLhf3eCOj1yNhM5GRMVK0aATxPZoz09YXjkQDmczJgquGQAPp9WwCNBgG027YACgUC6HRsAZRKBDAY2AJoNv/ZnwzA6WScznG3p4UAymXGAEkyXrTFAh8fLAGqagQAyGaZpYsi7bHTNPz8MEj//LxuFPo+UBS8vb0KaLXubrRa7aX0RMLCykwmn0z3+XA4WACcTpCkh9MFAZpmuVXo+mO/w+/HZvNgbblcUCxaSo/Hyck80Yu6XXDcvfVZr79cvMZjuN2U9O9vKAqjZrfbIZ0mV4TUi9Xqz6jddNy//7+e3n8Fhf/Llo2kxi8AQyGRoDkmAhAAAAAASUVORK5CYII=",
            },
          ],
        },
      ],
    }),
    validators: [hasOutput, completedStatus],
  },

  {
    id: "multi-turn",
    name: "Multi-turn Conversation",
    description: "Send assistant + user messages as conversation history",
    getRequest: (config) => ({
      model: config.model,
      input: [
        { type: "message", role: "user", content: "My name is Alice." },
        {
          type: "message",
          role: "assistant",
          content: "Hello Alice! Nice to meet you. How can I help you today?",
        },
        { type: "message", role: "user", content: "What is my name?" },
      ],
    }),
    validators: [hasOutput, completedStatus],
  },
];

async function makeRequest(
  config: TestConfig,
  body: TestRequestBody,
  streaming = false,
): Promise<Response> {
  const authValue = config.useBearerPrefix
    ? `Bearer ${config.apiKey}`
    : config.apiKey;

  return fetch(`${config.baseUrl}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [config.authHeaderName]: authValue,
    },
    body: JSON.stringify({ ...body, stream: streaming }),
  });
}

function toWebSocketUrl(baseUrl: string) {
  const responseUrl = new URL(`${baseUrl.replace(/\/$/, "")}/responses`);

  if (responseUrl.protocol === "https:") {
    responseUrl.protocol = "wss:";
  } else if (responseUrl.protocol === "http:") {
    responseUrl.protocol = "ws:";
  } else if (
    responseUrl.protocol !== "ws:" &&
    responseUrl.protocol !== "wss:"
  ) {
    throw new Error(
      `Unsupported base URL protocol for WebSocket: ${responseUrl.protocol}`,
    );
  }

  return responseUrl.toString();
}

async function makeWebSocketRequest(
  config: TestConfig,
  body: TestRequestBody,
): Promise<SSEParseResult> {
  const authValue = config.useBearerPrefix
    ? `Bearer ${config.apiKey}`
    : config.apiKey;

  return new Promise((resolve, reject) => {
    const events: SSEParseResult["events"] = [];
    const errors: string[] = [];
    let finalResponse: ResponseResource | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let ws: WebSocket | null = null;
    let settled = false;

    const clearPendingTimeout = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      clearPendingTimeout();
      try {
        ws?.close();
      } catch {
        // Ignore close errors after a terminal event.
      }
      resolve({ events, errors, finalResponse });
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearPendingTimeout();
      try {
        ws?.close();
      } catch {
        // Ignore close errors while rejecting the request.
      }
      reject(error);
    };

    const messageDataToString = (data: MessageEvent["data"]) => {
      if (typeof data === "string") return data;
      if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
      if (ArrayBuffer.isView(data)) {
        return new TextDecoder().decode(data);
      }
      return String(data);
    };

    timeout = setTimeout(() => {
      errors.push("Timed out waiting for terminal WebSocket response event");
      finish();
    }, 30000);

    try {
      type WebSocketConstructorWithHeaders = new (
        url: string | URL,
        options?: { headers?: Record<string, string> },
      ) => WebSocket;
      // Bun supports headers for client WebSockets; browser runs skip this path.
      const WebSocketWithHeaders =
        WebSocket as unknown as WebSocketConstructorWithHeaders;

      ws = new WebSocketWithHeaders(toWebSocketUrl(config.baseUrl), {
        headers: {
          "Content-Type": "application/json",
          [config.authHeaderName]: authValue,
        },
      });
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify(body));
    });

    ws.addEventListener("message", (message) => {
      const data = messageDataToString(message.data);
      if (data === "[DONE]") {
        finish();
        return;
      }

      try {
        const parsed = JSON.parse(data);
        const parsedEvent = parseStreamingEventData(parsed);
        events.push(parsedEvent);

        if (!parsedEvent.validationResult.success) {
          errors.push(
            `Event validation failed for ${parsedEvent.event}: ${JSON.stringify(parsedEvent.validationResult.error.issues)}`,
          );
        }

        const terminalResponse = getTerminalResponse(parsed);
        if (terminalResponse) {
          finalResponse = terminalResponse;
          finish();
          return;
        }

        if (parsedEvent.event === "error") {
          errors.push(`WebSocket error event: ${JSON.stringify(parsed)}`);
          finish();
        }
      } catch {
        errors.push(`Failed to parse WebSocket event data: ${data}`);
      }
    });

    ws.addEventListener("error", () => {
      fail(new Error("WebSocket connection failed"));
    });

    ws.addEventListener("close", () => {
      if (!settled && !finalResponse) {
        errors.push("WebSocket closed before a terminal response event");
      }
      finish();
    });
  });
}

async function runTest(
  template: TestTemplate,
  config: TestConfig,
): Promise<TestResult> {
  const startTime = Date.now();
  const streaming = template.streaming ?? false;
  const transport = template.transport ?? "http";

  const unsupportedReason = template.unsupportedReason?.(config);
  if (unsupportedReason) {
    return {
      id: template.id,
      name: template.name,
      description: template.description,
      status: "skipped",
      duration: 0,
      errors: [unsupportedReason],
    };
  }

  const requestBody = template.getRequest(config);

  try {
    if (transport === "websocket") {
      const sseResult = await makeWebSocketRequest(config, requestBody);
      const duration = Date.now() - startTime;
      const rawData = sseResult.finalResponse;

      const parseResult = responseResourceSchema.safeParse(rawData);
      if (!parseResult.success) {
        return {
          id: template.id,
          name: template.name,
          description: template.description,
          status: "failed",
          duration,
          request: requestBody,
          response: rawData,
          errors: [
            ...sseResult.errors,
            ...parseResult.error.issues.map(
              (issue) => `${issue.path.join(".")}: ${issue.message}`,
            ),
          ],
          streamEvents: sseResult.events.length,
        };
      }

      const context: ValidatorContext = {
        streaming,
        sseResult,
        transport,
      };
      const errors = template.validators.flatMap((v) =>
        v(parseResult.data, context),
      );

      return {
        id: template.id,
        name: template.name,
        description: template.description,
        status: errors.length === 0 ? "passed" : "failed",
        duration,
        request: requestBody,
        response: parseResult.data,
        errors,
        streamEvents: sseResult.events.length,
      };
    }

    const response = await makeRequest(config, requestBody, streaming);
    const duration = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text();
      return {
        id: template.id,
        name: template.name,
        description: template.description,
        status: "failed",
        duration,
        request: requestBody,
        response: errorText,
        errors: [`HTTP ${response.status}: ${errorText}`],
      };
    }

    let rawData: unknown;
    let sseResult: SSEParseResult | undefined;

    if (streaming) {
      sseResult = await parseSSEStream(response);
      rawData = sseResult.finalResponse;
    } else {
      rawData = await response.json();
    }

    // Parse with Zod first - schema validation
    const parseResult = responseResourceSchema.safeParse(rawData);
    if (!parseResult.success) {
      return {
        id: template.id,
        name: template.name,
        description: template.description,
        status: "failed",
        duration,
        request: streaming ? { ...requestBody, stream: true } : requestBody,
        response: rawData,
        errors: parseResult.error.issues.map(
          (issue) => `${issue.path.join(".")}: ${issue.message}`,
        ),
        streamEvents: sseResult?.events.length,
      };
    }

    // Run semantic validators on typed data
    const context: ValidatorContext = { streaming, sseResult, transport };
    const errors = template.validators.flatMap((v) =>
      v(parseResult.data, context),
    );

    return {
      id: template.id,
      name: template.name,
      description: template.description,
      status: errors.length === 0 ? "passed" : "failed",
      duration,
      request: streaming ? { ...requestBody, stream: true } : requestBody,
      response: parseResult.data,
      errors,
      streamEvents: sseResult?.events.length,
    };
  } catch (error) {
    return {
      id: template.id,
      name: template.name,
      description: template.description,
      status: "failed",
      duration: Date.now() - startTime,
      request: requestBody,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export async function runAllTests(
  config: TestConfig,
  onProgress: (result: TestResult) => void,
  templates = testTemplates,
): Promise<TestResult[]> {
  const promises = templates.map(async (template) => {
    const unsupportedReason = template.unsupportedReason?.(config);
    if (unsupportedReason) {
      const result: TestResult = {
        id: template.id,
        name: template.name,
        description: template.description,
        status: "skipped",
        duration: 0,
        errors: [unsupportedReason],
      };
      onProgress(result);
      return result;
    }

    onProgress({
      id: template.id,
      name: template.name,
      description: template.description,
      status: "running",
    });

    const result = await runTest(template, config);
    onProgress(result);
    return result;
  });

  return Promise.all(promises);
}
