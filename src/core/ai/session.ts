// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type Anthropic from '@anthropic-ai/sdk';
import { newId } from '../lib/ids';

import { sessionStore } from '../stores/root';
import { buildSystemPrompt, maxTokens, model } from './prompt';
import { type ToolDef, toolByName, toolSchemas } from './tools';

/**
 * The agentic loop.
 *
 * Runs client-side rather than using the SDK's tool runner, for one reason:
 * `commit` tools must SUSPEND the loop and wait for the contractor to approve
 * before the tool executes. The runner's per-turn hooks can gate, but the
 * suspension here spans a UI round trip of arbitrary length, which fits a
 * hand-written loop far better.
 *
 * The API key never reaches this code — the client points at the local proxy
 * with a placeholder and the proxy swaps in the real one.
 */

export type ChatRole = 'user' | 'assistant';

export interface ToolRun {
  id: string;
  name: string;
  tier: ToolDef['tier'];
  input: Record<string, unknown>;
  status: 'pending-approval' | 'running' | 'done' | 'failed' | 'rejected';
  /** Contractor-facing summary of what happened. */
  summary?: string;
  error?: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  /** Tool activity attributed to this assistant turn. */
  runs: ToolRun[];
  streaming?: boolean;
}

export interface Attachment {
  kind: 'image' | 'pdf';
  mediaType: string;
  /** Base64, without the data: prefix. */
  data: string;
  name: string;
}

export interface SessionCallbacks {
  onChange: (messages: ChatMessage[]) => void;
  /** Resolve true to run the tool, false to decline it. */
  onConfirm: (run: ToolRun, prompt: string) => Promise<boolean>;
}

const PROXY_PATH = '/api/anthropic';

/**
 * The SDK builds request URLs with `new URL(...)`, which rejects a bare path —
 * a relative baseURL throws "Invalid URL" before the first byte goes out. So
 * the same-origin proxy path is made absolute here. Still same-origin: the key
 * lives on the server either way.
 */
function proxyBaseUrl(): string {
  const origin = typeof globalThis.location === 'undefined' ? '' : globalThis.location.origin;
  return `${origin || 'http://localhost'}${PROXY_PATH}`;
}

export interface SessionOptions {
  /**
   * Transport override. Exists so the agentic loop — tool dispatch, the commit
   * gate, error handling — can be exercised against canned SSE without a key
   * and without the network. Production passes nothing.
   */
  fetch?: typeof globalThis.fetch;
}

/**
 * The SDK is loaded on demand.
 *
 * It is ~40% of the contractor bundle and nothing needs it until someone
 * actually opens the assistant and sends something — and on a deployment where
 * the dealer has switched the assistant off, never. A type-only import keeps
 * the types without pulling the code into the initial download.
 */
let sdkPromise: Promise<typeof import('@anthropic-ai/sdk')> | null = null;
/** Kept so error classification can use the SDK's real classes once loaded. */
let loadedSdk: typeof import('@anthropic-ai/sdk') | null = null;

function loadSdk(): Promise<typeof import('@anthropic-ai/sdk')> {
  // Cleared on failure. A cached rejected promise meant one offline moment —
  // or one stale chunk URL after a redeploy — left the assistant permanently
  // broken until a full reload, because every later send awaited the same
  // rejection.
  sdkPromise ??= import('@anthropic-ai/sdk')
    .then((module) => {
      loadedSdk = module;
      return module;
    })
    .catch((error) => {
      sdkPromise = null;
      throw error;
    });
  return sdkPromise;
}

async function createClient(options: SessionOptions): Promise<Anthropic> {
  const { default: AnthropicClient } = await loadSdk();
  return new AnthropicClient({
    // The proxy replaces this. A real key must never reach the browser.
    apiKey: 'proxied',
    baseURL: proxyBaseUrl(),
    dangerouslyAllowBrowser: true,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

/** Guards against a tool loop that never converges. */
const MAX_TURNS = 12;

/**
 * Tells the proxy which contractor account is spending the dealer's key, so
 * the admin console can show them who. Attribution, not authorization — the
 * server bounds what it will record and never trusts this for access.
 */
function accountHeaders(): Record<string, string> {
  const accountId = sessionStore.get().account?.id;
  return accountId ? { 'x-gn-account': accountId } : {};
}

export class AssistantSession {
  private client: Anthropic | null = null;
  private readonly options: SessionOptions;
  private readonly history: Anthropic.MessageParam[] = [];
  private messages: ChatMessage[] = [];
  private busy = false;
  private abortController: AbortController | null = null;
  private cancelRequested = false;
  /** Resolves when cancel() is called; races the commit-approval wait. */
  private cancelPromise: Promise<false> = new Promise(() => {});
  private resolveCancel: (() => void) | null = null;

  constructor(
    private readonly callbacks: SessionCallbacks,
    options: SessionOptions = {},
  ) {
    this.options = options;
  }

  /** Built once, on the first send, so the SDK download is not paid for by
   *  contractors who never open the assistant. */
  private async clientFor(): Promise<Anthropic> {
    this.client ??= await createClient(this.options);
    return this.client;
  }

  getMessages(): ChatMessage[] {
    return this.messages;
  }

  isBusy(): boolean {
    return this.busy;
  }

  /**
   * Stops the current turn: aborts the in-flight stream and treats any
   * commit approval still waiting as declined. Without this, closing the
   * sheet merely HID a running loop — tools kept mutating state and a
   * confirmation card kept waiting where nobody could see it.
   */
  cancel(): void {
    if (!this.busy) return;
    this.cancelRequested = true;
    this.resolveCancel?.();
    this.abortController?.abort();
  }

  private emit(): void {
    this.callbacks.onChange([...this.messages]);
  }

  private push(message: ChatMessage): ChatMessage {
    this.messages = [...this.messages, message];
    this.emit();
    return message;
  }

  async send(text: string, attachments: Attachment[] = []): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.cancelRequested = false;
    this.cancelPromise = new Promise((resolve) => {
      this.resolveCancel = () => resolve(false);
    });

    // Base64 payloads from earlier turns are re-sent on EVERY request in the
    // history — a couple of photos of a takeoff sheet compound into megabytes
    // per turn. The model has already read them; a placeholder keeps the
    // conversational record without re-shipping the bytes.
    pruneAttachmentBytes(this.history);

    this.push({ id: newId('m'), role: 'user', text, runs: [] });

    // A photo of a handwritten list or a supplier PDF is the input, so content
    // blocks carry attachments alongside the prompt.
    const content: Anthropic.ContentBlockParam[] = [
      ...attachments.map((file) =>
        file.kind === 'image'
          ? {
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: file.mediaType as 'image/png',
                data: file.data,
              },
            }
          : {
              type: 'document' as const,
              source: {
                type: 'base64' as const,
                media_type: 'application/pdf' as const,
                data: file.data,
              },
            },
      ),
      { type: 'text', text: text || 'Add these materials to my order.' },
    ];

    this.history.push({ role: 'user', content });

    try {
      await this.runLoop();
    } catch (error) {
      // A failed stream leaves a phantom bubble frozen mid-stream; clear it.
      this.messages = this.messages
        .filter((message) => !(message.streaming && !message.text && message.runs.length === 0))
        .map((message) => (message.streaming ? { ...message, streaming: false } : message));

      // And it can leave the transcript ending on a 'user' entry (the prompt,
      // or a batch of tool_results). One more user message would then violate
      // role alternation and 400 every subsequent request — the session would
      // be dead until reload. A synthetic assistant entry keeps it legal.
      const last = this.history[this.history.length - 1];
      if (last?.role === 'user') {
        this.history.push({
          role: 'assistant',
          content: [{ type: 'text', text: '(This turn was interrupted before it finished.)' }],
        });
      }

      this.push({
        id: newId('m'),
        role: 'assistant',
        text: this.cancelRequested ? 'Stopped.' : describeError(error),
        runs: [],
      });
    } finally {
      this.busy = false;
      this.resolveCancel = null;
      this.emit();
    }
  }

  private async runLoop(): Promise<void> {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const bubble = this.push({
        id: newId('m'),
        role: 'assistant',
        text: '',
        runs: [],
        streaming: true,
      });

      this.abortController = new AbortController();
      // Read the key per REQUEST, not at construction: the session lives for
      // the app's lifetime, so a key pasted mid-conversation has to take
      // effect on the very next turn without a reload.
      const stream = (await this.clientFor()).messages.stream(
        {
          // Read per request so an admin change lands without a reload.
          model: model(),
          max_tokens: maxTokens(),
          // Adaptive thinking with high effort: this is agentic tool use where a
          // wrong SKU match or a missed guard has real consequences.
          thinking: { type: 'adaptive' },
          output_config: { effort: 'high' },
          system: buildSystemPrompt(),
          tools: toolSchemas(),
          messages: this.history,
        },
        { signal: this.abortController.signal, headers: accountHeaders() },
      );

      stream.on('text', (delta) => {
        bubble.text += delta;
        this.emit();
      });

      const response = await stream.finalMessage();
      bubble.streaming = false;
      bubble.text = textOf(response);
      this.emit();

      this.history.push({ role: 'assistant', content: response.content });

      const calls = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );

      // Output-limit cutoff mid-tool-call: the tool_use blocks in history MUST
      // each get a tool_result or every later request 400s. Refuse them and
      // give the model a chance to retry smaller.
      if (response.stop_reason === 'max_tokens' && calls.length > 0) {
        this.history.push({
          role: 'user',
          content: calls.map((call) => ({
            type: 'tool_result' as const,
            tool_use_id: call.id,
            content: 'This call was cut off by the output limit. Retry with a smaller batch.',
            is_error: true,
          })),
        });
        continue;
      }

      if (response.stop_reason !== 'tool_use') {
        // Drop an empty trailing bubble when the turn was pure tool use.
        if (!bubble.text && bubble.runs.length === 0) {
          this.messages = this.messages.filter((message) => message.id !== bubble.id);
          this.emit();
        }
        return;
      }

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of calls) {
        results.push(await this.executeCall(call, bubble));
      }

      this.history.push({ role: 'user', content: results });

      if (this.cancelRequested) break;
    }

    const capText = this.cancelRequested
      ? 'Stopped.'
      : "I've gone back and forth on this too many times without finishing. Tell me what you'd like me to focus on.";
    // The loop above always leaves history on a 'user' entry (tool results).
    // Mirror the visible cap message into it, or the next send would put two
    // user turns back-to-back and the API would reject the whole session.
    this.history.push({ role: 'assistant', content: [{ type: 'text', text: capText }] });
    this.push({ id: newId('m'), role: 'assistant', text: capText, runs: [] });
  }

  private async executeCall(
    call: Anthropic.ToolUseBlock,
    bubble: ChatMessage,
  ): Promise<Anthropic.ToolResultBlockParam> {
    const tool = toolByName(call.name);
    const input = (call.input ?? {}) as Record<string, unknown>;

    if (!tool) {
      return {
        type: 'tool_result',
        tool_use_id: call.id,
        content: `No tool named ${call.name}.`,
        is_error: true,
      };
    }

    const run: ToolRun = {
      id: call.id,
      name: tool.name,
      tier: tool.tier,
      input,
      status: tool.tier === 'commit' ? 'pending-approval' : 'running',
    };
    bubble.runs = [...bubble.runs, run];
    this.emit();

    // Anything reaching the supplier or moving money stops here for approval.
    if (tool.tier === 'commit') {
      const prompt = tool.confirm?.(input) ?? `Run ${tool.name}?`;
      // Race against cancel(): a confirm left waiting in a closed sheet must
      // resolve as declined, not hold the loop suspended forever.
      const approved = await Promise.race([
        this.callbacks.onConfirm(run, prompt),
        this.cancelPromise,
      ]);
      if (!approved) {
        run.status = 'rejected';
        run.summary = 'Declined';
        this.emit();
        return {
          type: 'tool_result',
          tool_use_id: call.id,
          content:
            'The contractor declined this action. Do not retry it. Acknowledge briefly and ask what they would like instead.',
        };
      }
      run.status = 'running';
      this.emit();
    }

    const result = tool.run(input);

    if (!result.ok) {
      run.status = 'failed';
      run.error = result.error;
      this.emit();
      // The refusal sentence goes back verbatim so the model can self-correct
      // using the same words the contractor would see.
      return { type: 'tool_result', tool_use_id: call.id, content: result.error, is_error: true };
    }

    run.status = 'done';
    run.summary = summarize(tool, input, result.value);
    this.emit();

    return {
      type: 'tool_result',
      tool_use_id: call.id,
      content: JSON.stringify(result.value ?? { ok: true }),
    };
  }
}

/**
 * Replaces base64 image/document sources in past user turns with a short text
 * placeholder. Mutates in place; the current (not-yet-answered) turn is never
 * pruned because the model still needs to read it.
 */
function pruneAttachmentBytes(history: Anthropic.MessageParam[]): void {
  for (const entry of history) {
    if (entry.role !== 'user' || !Array.isArray(entry.content)) continue;
    entry.content = entry.content.map((block) =>
      block.type === 'image' || block.type === 'document'
        ? { type: 'text' as const, text: '[Attachment shared earlier in this conversation.]' }
        : block,
    );
  }
}

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/** Short, contractor-readable label for the tool card. */
function summarize(tool: ToolDef, input: Record<string, unknown>, value: unknown): string {
  switch (tool.name) {
    case 'add_materials':
      return `Added ${input.qty} × ${input.product}`;
    case 'add_special_order_item':
      return `Flagged "${input.description}" for dealer pricing`;
    case 'update_quantity':
      return `Set quantity to ${input.qty}`;
    case 'remove_line':
      return 'Removed a line';
    case 'create_order':
      return `Created order "${input.name}"`;
    case 'create_project':
      return `Created project "${input.name}"`;
    case 'move_order_stage':
      return `Moved to ${input.stage}`;
    case 'send_customer_quote':
      return 'Sent to customer';
    case 'pay_invoices':
      return 'Payment submitted';
    case 'build_customer_quote':
      return 'Built customer quote';
    case 'search_catalog':
      return `Searched for "${input.query}"`;
    case 'get_board':
      return 'Read the board';
    case 'get_order':
      return 'Read the order';
    case 'get_open_invoices':
      return 'Checked open invoices';
    default:
      return value === undefined ? tool.name : tool.name;
  }
}

/**
 * Classifies an SDK error without a static import of the SDK — which is what
 * lets the SDK be lazy-loaded at all.
 *
 * Uses the real classes when the module is already in memory (it always is by
 * the time an error can happen, since sending is what loads it), and falls
 * back to the wire shape otherwise. Duck-typing alone is not enough: the SDK
 * does not set `name` on its error classes, so an APIConnectionError arrives
 * as a plain "Error" and would have been reported as a bare
 * "Connection error." with no advice attached.
 */
function describeError(error: unknown): string {
  const Sdk = loadedSdk?.default;
  const status = (error as { status?: unknown })?.status;

  const isAuth = Sdk ? error instanceof Sdk.AuthenticationError : status === 401 || status === 403;
  if (isAuth) {
    // The contractor cannot fix this one: the credential is the dealer's, set
    // in their admin console. Telling them to check a key they do not have
    // would just waste their time.
    return 'The assistant could not authenticate. The supplier needs to check the API key in their admin console.';
  }

  const isRateLimited = Sdk ? error instanceof Sdk.RateLimitError : status === 429;
  if (isRateLimited) {
    // The proxy returns 429 for two very different reasons, and telling a
    // contractor to "try again in a moment" when the DEALER's daily cap is
    // spent sends them round in circles for the rest of the day.
    const body = (error as { message?: unknown })?.message;
    const daily = typeof body === 'string' && /daily/i.test(body);
    return daily
      ? 'This deployment has used its assistant allowance for today. It resets tomorrow — or add your own API key to keep going now.'
      : 'Rate limited. Give it a moment and try again.';
  }

  // A connection failure has no status, and "error (undefined)" is not a
  // sentence anyone should be shown.
  const isConnection = Sdk
    ? error instanceof Sdk.APIConnectionError
    : status === undefined && error instanceof Error;
  if (isConnection) {
    return "Couldn't reach the assistant. Check your connection and try again.";
  }

  if (typeof status === 'number') {
    return `The assistant hit an error (${status}). ${readableMessage(error)}`.trim();
  }
  return readableMessage(error);
}

/**
 * A sentence, never a payload. The SDK puts the upstream response body in
 * `message` for unclassified errors, so this used to dump raw JSON into the
 * contractor's chat.
 */
function readableMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (!message) return 'Something went wrong.';
  const looksLikeJson = message.trimStart().startsWith('{') || message.includes('"type":');
  return looksLikeJson || message.length > 200 ? 'Something went wrong.' : message;
}
