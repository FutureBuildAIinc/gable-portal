// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { boot } from '../../boot';
import { ordersStore, scopeStore } from '../../stores/root';
import { listOf } from '../../stores/store';
import { AssistantSession, type ChatMessage, type ToolRun } from '../session';

/**
 * The agentic loop, driven by canned SSE.
 *
 * No key and no network: the transport is stubbed, so what is under test is
 * ours — tool dispatch, the commit gate, refusal relay, and the turn cap. The
 * one thing this cannot prove is how the real model behaves, which is why the
 * live round trip still needs a human with a key.
 */

beforeAll(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
});

const PERGOLA = 'ord_miller_pergola';
const MILLER_FRAME = 'ord_miller_frame';

type Turn =
  | { text: string }
  | { toolName: string; toolInput: Record<string, unknown>; text?: string };

/** Builds the SSE frames the SDK's stream parser expects for one turn. */
function sseFor(turn: Turn, index: number): string {
  const isTool = 'toolName' in turn;
  const frames: [string, unknown][] = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: `msg_${index}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-8',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
    ],
  ];

  let block = 0;
  const text = turn.text ?? '';
  if (text) {
    frames.push(
      [
        'content_block_start',
        {
          type: 'content_block_start',
          index: block,
          content_block: { type: 'text', text: '' },
        },
      ],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: block,
          delta: { type: 'text_delta', text },
        },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: block }],
    );
    block += 1;
  }

  if (isTool) {
    frames.push(
      [
        'content_block_start',
        {
          type: 'content_block_start',
          index: block,
          content_block: {
            type: 'tool_use',
            id: `toolu_${index}`,
            name: turn.toolName,
            input: {},
          },
        },
      ],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: block,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(turn.toolInput) },
        },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: block }],
    );
  }

  frames.push(
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: isTool ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: 20 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  );

  return frames
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
}

/** A transport that replays `turns` in order, one per request. */
function fakeTransport(turns: Turn[]) {
  const seen: unknown[] = [];
  let call = 0;

  const fetchImpl = async (_url: unknown, init?: { body?: unknown }) => {
    seen.push(JSON.parse(String(init?.body ?? '{}')));
    const turn = turns[Math.min(call, turns.length - 1)];
    call += 1;
    if (!turn) throw new Error('no turn configured');
    return new Response(sseFor(turn, call), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };

  return { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch, seen, calls: () => call };
}

interface Harness {
  session: AssistantSession;
  messages: () => ChatMessage[];
  prompts: string[];
  seen: unknown[];
}

function harness(turns: Turn[], approve: boolean | ((run: ToolRun) => boolean) = true): Harness {
  const transport = fakeTransport(turns);
  let latest: ChatMessage[] = [];
  const prompts: string[] = [];

  const session = new AssistantSession(
    {
      onChange: (messages) => {
        latest = messages;
      },
      onConfirm: async (run, prompt) => {
        prompts.push(prompt);
        return typeof approve === 'function' ? approve(run) : approve;
      },
    },
    { fetch: transport.fetchImpl },
  );

  return { session, messages: () => latest, prompts, seen: transport.seen };
}

function itemsOf(orderId: string) {
  return listOf(scopeStore.get()).filter((item) => item.orderId === orderId);
}

beforeEach(() => boot({ reset: true, seed: 20_260_730 }));

describe('the loop', () => {
  it('runs a write tool without asking, then reports what it did', async () => {
    const h = harness([
      {
        toolName: 'add_materials',
        toolInput: { orderId: PERGOLA, product: 'LBR-2X4-8-DF', qty: 40 },
      },
      { text: 'Added 40 studs.' },
    ]);

    await h.session.send('40 2x4x8 studs on the pergola');

    expect(h.prompts).toEqual([]); // a draft edit needs no approval
    expect(itemsOf(PERGOLA)[0]?.qty).toBe(40);

    const runs = h.messages().flatMap((message) => message.runs);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('done');
    expect(runs[0]?.summary).toContain('40');
  });

  it('feeds the tool result back so the model gets a second turn', async () => {
    const h = harness([
      { toolName: 'get_board', toolInput: {} },
      { text: 'Two orders need attention.' },
    ]);

    await h.session.send('what needs attention?');

    expect(h.seen).toHaveLength(2);
    const second = h.seen[1] as { messages: { role: string; content: unknown }[] };
    const last = second.messages[second.messages.length - 1];
    expect(last?.role).toBe('user');
    expect(JSON.stringify(last?.content)).toContain('tool_result');
  });

  it('stops a supplier-facing move until the contractor approves it', async () => {
    const h = harness(
      [
        { toolName: 'move_order_stage', toolInput: { orderId: MILLER_FRAME, stage: 'quote' } },
        { text: 'Left it in Plan.' },
      ],
      false,
    );

    await h.session.send('send the framing package to the quote desk');

    expect(h.prompts[0]).toContain('quote desk');
    // Declined means it never ran — the card has not moved.
    expect(ordersStore.get().byId[MILLER_FRAME]?.stage).toBe('plan');

    const run = h.messages().flatMap((message) => message.runs)[0];
    expect(run?.status).toBe('rejected');

    const followUp = h.seen[1] as { messages: { content: unknown }[] };
    expect(JSON.stringify(followUp.messages.at(-1)?.content)).toContain('declined');
  });

  it('actually moves the card once approved', async () => {
    const h = harness([
      { toolName: 'move_order_stage', toolInput: { orderId: MILLER_FRAME, stage: 'quote' } },
      { text: 'Sent.' },
    ]);

    await h.session.send('send it to the quote desk');
    expect(ordersStore.get().byId[MILLER_FRAME]?.stage).toBe('quote');
  });

  it("hands a guard's own sentence back to the model verbatim", async () => {
    const h = harness([
      { toolName: 'move_order_stage', toolInput: { orderId: PERGOLA, stage: 'order' } },
      { text: "That order is empty, so I can't place it." },
    ]);

    await h.session.send('place the pergola order');

    const run = h.messages().flatMap((message) => message.runs)[0];
    expect(run?.status).toBe('failed');
    expect(run?.error).toBeTruthy();

    const followUp = h.seen[1] as { messages: { content: { content?: string }[] }[] };
    const toolResult = followUp.messages.at(-1)?.content?.[0];
    // Same words the contractor sees on a rejected drop — not a paraphrase.
    expect(toolResult?.content).toBe(run?.error);
  });

  it('refuses a tool that does not exist rather than throwing', async () => {
    const h = harness([
      { toolName: 'delete_everything', toolInput: {} },
      { text: 'I can’t do that.' },
    ]);

    await h.session.send('delete everything');
    expect(h.seen).toHaveLength(2);
    expect(JSON.stringify(h.seen[1])).toContain('No tool named delete_everything');
  });

  it('gives up instead of looping forever', async () => {
    // Every turn asks for another tool call; nothing ever ends the turn.
    const h = harness([{ toolName: 'get_board', toolInput: {} }]);

    await h.session.send('go');

    const text = h
      .messages()
      .map((message) => message.text)
      .join(' ');
    expect(text).toContain('too many times');
    expect(h.seen.length).toBeLessThanOrEqual(12);
  });

  it('surfaces a transport failure as a message rather than an unhandled rejection', async () => {
    let latest: ChatMessage[] = [];
    const session = new AssistantSession(
      {
        onChange: (messages) => {
          latest = messages;
        },
        onConfirm: async () => true,
      },
      {
        fetch: (async () => {
          throw new Error('proxy unreachable');
        }) as unknown as typeof globalThis.fetch,
      },
    );

    await session.send('hello');
    const shown = latest.at(-1)?.text ?? '';
    expect(shown).toContain("Couldn't reach the assistant");
    // Whatever the SDK wraps it in, the contractor never sees "(undefined)".
    expect(shown).not.toContain('undefined');
  });

  it('sends a photo of a list as an image block alongside the prompt', async () => {
    const h = harness([{ text: 'I can read that.' }]);

    await h.session.send('add these', [
      { kind: 'image', mediaType: 'image/png', data: 'aGk=', name: 'list.png' },
    ]);

    const first = h.seen[0] as { messages: { content: { type: string }[] }[] };
    expect(first.messages[0]?.content?.[0]?.type).toBe('image');
    expect(first.messages[0]?.content?.[1]?.type).toBe('text');
  });
});

describe('cancel', () => {
  it('treats a confirm abandoned by cancel() as declined and stops the loop', async () => {
    const transport = fakeTransport([
      { toolName: 'move_order_stage', toolInput: { orderId: MILLER_FRAME, stage: 'quote' } },
      { text: 'never reached' },
    ]);
    let latest: ChatMessage[] = [];
    let session: AssistantSession | null = null;

    session = new AssistantSession(
      {
        onChange: (messages) => {
          latest = messages;
        },
        // The sheet never answers — the contractor closed it instead.
        onConfirm: () => {
          queueMicrotask(() => session?.cancel());
          return new Promise<boolean>(() => {});
        },
      },
      { fetch: transport.fetchImpl },
    );

    await session.send('send it to the quote desk');

    // Declined means never ran.
    expect(ordersStore.get().byId[MILLER_FRAME]?.stage).toBe('plan');
    const run = latest.flatMap((message) => message.runs)[0];
    expect(run?.status).toBe('rejected');
    expect(latest.at(-1)?.text).toBe('Stopped.');
    expect(session.isBusy()).toBe(false);

    // And the session is still alive: a fresh send works.
    const again = await session.send('hello');
    expect(again).toBeUndefined();
  });
});
