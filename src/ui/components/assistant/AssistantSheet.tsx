// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import {
  AssistantSession,
  type Attachment,
  type ChatMessage,
  type ToolRun,
} from '@core/ai/session';
import { supplierName } from '@core/config/runtime';
import { Button } from '@ui/components/ui/Button';
import { cn } from '@ui/lib/cn';
import {
  AlertTriangle,
  ArrowUp,
  Check,
  Image as ImageIcon,
  Loader2,
  Mic,
  Paperclip,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The assistant.
 *
 * Its job here is capturing a material list the contractor already has — typed,
 * dictated, or photographed — so the input row treats attachment and voice as
 * first-class, not as an afterthought behind a menu.
 *
 * Tool activity is shown as it happens rather than hidden: a contractor is
 * about to order from these lines, and "it added 12 things" with no visible
 * detail is not something anyone should trust.
 */

interface Props {
  open: boolean;
  onClose: () => void;
  /** Null until the boot health check resolves. False = no server key AND no
   *  key of the contractor's own. */
  hasKey: boolean | null;
}

interface Pending {
  run: ToolRun;
  prompt: string;
  resolve: (approved: boolean) => void;
}

export function AssistantSheet({ open, onClose, hasKey }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);

  const sessionRef = useRef<AssistantSession | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // biome-ignore lint/suspicious/noExplicitAny: vendor-prefixed browser API
  const recognitionRef = useRef<any>(null);

  if (!sessionRef.current) {
    sessionRef.current = new AssistantSession({
      onChange: setMessages,
      onConfirm: (run, prompt) =>
        new Promise<boolean>((resolve) => {
          setPending({ run, prompt, resolve });
        }),
    });
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new content
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, pending]);

  // The mic must die with the component — a hot microphone attached to an
  // unmounted sheet is indefensible.
  useEffect(() => stopDictation, []);

  const submit = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || busy) return;
    if (!draft.trim() && attachments.length === 0) return;

    const text = draft;
    const files = attachments;
    setDraft('');
    setAttachments([]);
    setBusy(true);
    await session.send(text, files);
    setBusy(false);
  }, [draft, attachments, busy]);

  async function attach(files: FileList | null) {
    if (!files) return;
    const next: Attachment[] = [];
    for (const file of Array.from(files).slice(0, 4)) {
      const data = await toBase64(file);
      if (file.type.startsWith('image/')) {
        next.push({ kind: 'image', mediaType: file.type, data, name: file.name });
      } else if (file.type === 'application/pdf') {
        next.push({ kind: 'pdf', mediaType: file.type, data, name: file.name });
      }
    }
    setAttachments((current) => [...current, ...next]);
  }

  /**
   * Browser dictation. Contractors are often on a site with gloves on, and
   * reading a list aloud beats typing it. Falls back silently where the API
   * is unavailable (Firefox) rather than showing a dead button.
   */
  function startDictation() {
    const Recognition =
      // biome-ignore lint/suspicious/noExplicitAny: vendor-prefixed browser API
      (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!Recognition) return;

    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (event: {
      results: { transcript: string }[][];
      resultIndex: number;
    }) => {
      const said = event.results[event.results.length - 1]?.[0]?.transcript ?? '';
      setDraft((current) => (current ? `${current} ${said}` : said));
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setListening(false);
    };
    recognition.onerror = () => {
      recognitionRef.current = null;
      setListening(false);
    };
    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }

  function stopDictation() {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setListening(false);
  }

  /**
   * Closing while a turn is running cancels it — the alternative was a sheet
   * that merely hid a live agent: tools kept mutating the order and a
   * commit-approval card sat waiting where nobody could see it.
   */
  function close() {
    stopDictation();
    if (pending) {
      pending.resolve(false);
      setPending(null);
    }
    sessionRef.current?.cancel();
    onClose();
  }

  if (!open) return null;

  const voiceAvailable =
    typeof window !== 'undefined' &&
    // biome-ignore lint/suspicious/noExplicitAny: vendor-prefixed browser API
    Boolean((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-surface lg:inset-y-0 lg:right-0 lg:left-auto lg:w-[26rem] lg:border-border lg:border-l lg:shadow-[var(--shadow-lifted)]">
      <header className="flex shrink-0 items-center justify-between border-border border-b px-4 py-3 safe-top">
        <span className="inline-flex items-center gap-2 font-semibold text-[15px]">
          <Sparkles size={16} strokeWidth={2} style={{ color: 'var(--brand)' }} />
          Assistant
        </span>
        <button type="button" onClick={close} aria-label="Close assistant" className="p-1.5">
          <X size={20} strokeWidth={2} />
        </button>
      </header>

      <div
        ref={scrollRef}
        className={cn(
          'min-h-0 flex-1 overflow-y-auto px-4 py-4',
          // An idle panel centres its invitation; once there is a conversation
          // it has to behave like a normal transcript and start at the top.
          messages.length === 0 && !pending && 'flex flex-col justify-center',
        )}
      >
        {hasKey === false ? <NoKeyNotice /> : null}
        {messages.length === 0 && hasKey !== false ? (
          <EmptyState
            onPrompt={(text) => setDraft(text)}
            onAttach={() => fileRef.current?.click()}
          />
        ) : null}

        <div className="space-y-4">
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
        </div>

        {pending ? (
          <ConfirmCard
            prompt={pending.prompt}
            onDecide={(approved) => {
              pending.resolve(approved);
              setPending(null);
            }}
          />
        ) : null}
      </div>

      <div className="shrink-0 border-border border-t p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {attachments.length > 0 ? (
          <ul className="mb-2 flex flex-wrap gap-1.5">
            {attachments.map((file, index) => (
              <li
                key={`${file.name}-${index}`}
                className="inline-flex items-center gap-1.5 rounded-md bg-surface-3 px-2 py-1 text-[11.5px]"
              >
                <ImageIcon size={11} strokeWidth={2} />
                <span className="max-w-32 truncate">{file.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => setAttachments((c) => c.filter((_, i) => i !== index))}
                >
                  <X size={11} strokeWidth={2.5} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex items-end gap-1.5">
          <input
            ref={fileRef}
            type="file"
            accept="image/*,application/pdf"
            multiple
            className="hidden"
            onChange={(event) => attach(event.target.files)}
          />
          <IconButton
            label="Attach a photo or PDF of your list"
            onClick={() => fileRef.current?.click()}
            disabled={hasKey === false}
          >
            <Paperclip size={17} strokeWidth={2} />
          </IconButton>

          {voiceAvailable ? (
            <IconButton
              label={listening ? 'Stop listening' : 'Dictate your list'}
              onClick={listening ? stopDictation : startDictation}
              disabled={hasKey === false}
              active={listening}
            >
              <Mic size={17} strokeWidth={2} />
            </IconButton>
          ) : null}

          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            rows={1}
            disabled={hasKey === false}
            placeholder={
              // The field is narrow next to three 44px controls, so anything
              // longer than this wraps and gets clipped by the one-row height.
              hasKey === false ? 'Assistant unavailable' : 'Your material list…'
            }
            className="max-h-32 min-h-11 flex-1 resize-none rounded-lg border border-border bg-surface px-3 py-2.5 text-sm outline-none focus:border-brand disabled:opacity-50"
          />

          {busy ? (
            <Button
              size="icon"
              aria-label="Stop"
              variant="secondary"
              onClick={() => {
                if (pending) {
                  pending.resolve(false);
                  setPending(null);
                }
                sessionRef.current?.cancel();
              }}
            >
              <Square size={15} strokeWidth={2.5} />
            </Button>
          ) : (
            <Button
              size="icon"
              aria-label="Send"
              disabled={hasKey === false || (!draft.trim() && attachments.length === 0)}
              onClick={submit}
            >
              <ArrowUp size={17} strokeWidth={2.5} />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-brand px-3.5 py-2 text-[13.5px] text-brand-on">
          {message.text}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {message.runs.length > 0 ? (
        <ul className="space-y-1">
          {message.runs.map((run) => (
            <ToolCard key={run.id} run={run} />
          ))}
        </ul>
      ) : null}

      {message.text ? (
        <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed">
          {message.text}
          {message.streaming ? <span className="ml-0.5 animate-pulse">▍</span> : null}
        </p>
      ) : message.streaming && message.runs.length === 0 ? (
        <p className="text-[13px] text-text-subtle">Thinking…</p>
      ) : null}
    </div>
  );
}

/** Shows what the assistant actually did — never just "done". */
function ToolCard({ run }: { run: ToolRun }) {
  const failed = run.status === 'failed';
  const rejected = run.status === 'rejected';

  return (
    <li
      className={cn(
        'flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-[12px]',
        failed ? 'border-transparent' : 'border-border',
      )}
      style={
        failed
          ? { background: 'color-mix(in oklch, var(--warning), transparent 90%)' }
          : { background: 'var(--surface-inset)' }
      }
    >
      <span className="mt-0.5 shrink-0">
        {run.status === 'running' || run.status === 'pending-approval' ? (
          <Loader2 size={12} strokeWidth={2.5} className="animate-spin text-text-subtle" />
        ) : failed ? (
          <AlertTriangle size={12} strokeWidth={2.5} style={{ color: 'var(--warning)' }} />
        ) : rejected ? (
          <X size={12} strokeWidth={2.5} className="text-text-subtle" />
        ) : (
          <Check size={12} strokeWidth={3} style={{ color: 'var(--success)' }} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block', failed && 'font-medium')}>
          {run.summary ?? humanize(run.name)}
        </span>
        {/* The action's own refusal sentence, verbatim — the same words the
            board would show on a rejected drag. */}
        {run.error ? <span className="mt-0.5 block text-text-muted">{run.error}</span> : null}
      </span>
    </li>
  );
}

function ConfirmCard({
  prompt,
  onDecide,
}: {
  prompt: string;
  onDecide: (approved: boolean) => void;
}) {
  return (
    <div className="mt-4 rounded-[var(--radius-card)] border border-border bg-surface p-3 shadow-[var(--shadow-card)]">
      <p className="text-[13.5px] leading-snug">{prompt}</p>
      <p className="mt-1 text-[11.5px] text-text-subtle">
        This reaches {supplierName()} — it won't happen unless you approve it.
      </p>
      <div className="mt-3 flex gap-2">
        <Button size="sm" variant="outline" className="flex-1" onClick={() => onDecide(false)}>
          Not now
        </Button>
        <Button size="sm" className="flex-[2]" onClick={() => onDecide(true)}>
          Approve
        </Button>
      </div>
    </div>
  );
}

/**
 * The invitation. The examples are BUTTONS, not grey prose: a contractor who
 * doesn't know what to type gets a working first turn in one tap, and bordered
 * chips survive daylight in a way text-subtle never did.
 */
function EmptyState({
  onPrompt,
  onAttach,
}: {
  onPrompt: (text: string) => void;
  onAttach: () => void;
}) {
  const examples = [
    '40 2x6x12 PT, 6 6x6 posts, 12 bags of concrete',
    "What's overdue?",
    'What needs my attention today?',
  ];

  return (
    <div className="py-6">
      <p className="text-[13.5px] leading-relaxed text-text-muted">
        Give me your material list however you have it — typed, read out loud, or a photo of the
        sheet. I'll match it to the {supplierName()} catalog and put it on an order.
      </p>
      <div className="mt-3 space-y-2">
        <button
          type="button"
          onClick={onAttach}
          className="flex min-h-11 w-full items-center gap-2.5 rounded-lg border border-border bg-surface-inset px-3 text-left text-[13px] transition-colors hover:bg-surface-3"
        >
          <ImageIcon size={15} strokeWidth={2} style={{ color: 'var(--brand)' }} />
          Snap the takeoff sheet on your clipboard
        </button>
        {examples.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => onPrompt(example)}
            className="flex min-h-11 w-full items-center gap-2.5 rounded-lg border border-border bg-surface-inset px-3 text-left text-[13px] transition-colors hover:bg-surface-3"
          >
            <Sparkles size={15} strokeWidth={2} style={{ color: 'var(--brand)' }} />
            <span className="min-w-0 flex-1 truncate">{example}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * With no key the assistant is disabled rather than faked. A mock assistant
 * would undermine the one part of this product that has to be real.
 */
/**
 * No key, and nothing the contractor can do about it.
 *
 * There is deliberately no "add your key" button any more: the credential is
 * the dealer's, configured in their admin console. Offering a contractor a
 * remedy they cannot perform is worse than telling them who to ask.
 */
function NoKeyNotice() {
  return (
    <div className="mb-4 rounded-lg border border-border bg-surface-inset p-3">
      <p className="font-medium text-[13px]">The assistant isn't switched on yet</p>
      <p className="mt-1 text-[12.5px] leading-relaxed text-text-muted">
        It runs on a real Claude model — there's no canned stand-in. {supplierName()} needs to
        enable it for this deployment before you can use it.
      </p>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex h-11 w-11 shrink-0 items-center justify-center rounded-lg transition-colors',
        'disabled:text-text-subtle disabled:opacity-60',
        active ? 'text-danger' : 'text-text-muted hover:bg-surface-3 hover:text-text',
      )}
    >
      {children}
    </button>
  );
}

function humanize(name: string): string {
  return name.replace(/_/g, ' ');
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
