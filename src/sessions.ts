import { createHash, randomBytes } from 'node:crypto';
import { canonicalModel } from './models.js';
import { ProxyError, type ChatCompletionRequest, type ChatMessage, type ToolCall } from './types.js';
import type { ApprovalRequest, CliRunner } from './providers/base.js';
import { AsyncQueue } from './utils/async-queue.js';
import { formatPrompt } from './utils/prompt-formatter.js';

export type SessionEvent = { type: 'text'; text: string } | { type: 'approval'; text: string } | { type: 'tool'; call: ToolCall } | { type: 'end' } | { type: 'error'; error: Error };
type Pending = { token: string; event: SessionEvent; callId?: string; kind: 'approval' | 'tool'; resolve: (value: any) => void; reject: (error: Error) => void };
export const APPROVAL_TOOL = 'proxy_approve_action';

export function messageText(message: ChatMessage | undefined): string {
  return typeof message?.content === 'string' ? message.content : message?.content?.map(part => part.text).join('') ?? '';
}

function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function transcriptHash(messages: ChatMessage[]): string {
  return hash(messages.map(message => ({ role: message.role, content: messageText(message), tool_calls: message.tool_calls ?? [], tool_call_id: message.tool_call_id ?? '' })));
}

export function approvalDecision(text: string): boolean | undefined {
  const value = text.trim().normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  if (['aprovar', 'allow', 'y', 'sim'].includes(value)) return true;
  if (['negar', 'deny', 'n', 'nao'].includes(value)) return false;
  return undefined;
}

export function authorizationPrompt(request: ApprovalRequest, token: string): string {
  const fence = '`'.repeat(Math.max(3, ...[...request.action.matchAll(/`+/g)].map(match => match[0].length + 1)));
  return `\n\n⚠️ **Solicitação de Permissão de Execução**\n\nO modelo deseja executar a seguinte ação:\n\n${fence}bash\n${request.action}\n${fence}\n\nDiretório: ${request.cwd ?? '(não informado)'}\n\nMotivo: ${request.reason ?? '(não informado)'}\n\nResponda **\`aprovar\`** (ou \`allow\` / \`y\` / \`sim\`) para autorizar e executar, ou **\`negar\`** (ou \`deny\` / \`n\` / \`não\`) para cancelar.\n\n<!-- cli-proxy-approval:${token} -->`;
}

export class AgentSession {
  readonly events = new AsyncQueue<SessionEvent>();
  readonly controller = new AbortController();
  readonly id = randomBytes(24).toString('hex');
  pending: Pending | undefined;
  contextHash: string;
  busy = false;
  terminal = false;
  job: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;

  constructor(readonly model: string, readonly principal: string, body: ChatCompletionRequest, private timeoutMs: number, private approvalMs: number, private remove: () => void) {
    this.contextHash = transcriptHash(body.messages);
  }

  private arm(ms: number, error: ProxyError): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.cancel(error), ms);
    this.timer.unref();
  }

  armExecution(): void { this.arm(this.timeoutMs, new ProxyError('CLI request timed out.', 504, 'cli_timeout')); }

  private wait<T>(kind: 'approval' | 'tool', makeEvent: (token: string) => SessionEvent): Promise<T> {
    this.controller.signal.throwIfAborted();
    if (this.pending) return Promise.reject(new ProxyError('Concurrent CLI approval requests are not supported.', 409, 'approval_conflict'));
    const token = `${this.id}.${randomBytes(16).toString('hex')}`;
    return new Promise<T>((resolve, reject) => {
      const event = makeEvent(token);
      this.pending = { token, kind, event, ...(event.type === 'tool' ? { callId: event.call.id } : {}), resolve, reject };
      this.arm(this.approvalMs, new ProxyError('Pending approval expired. Submit the original request again.', 410, 'approval_expired'));
      this.events.push(event);
    });
  }

  start(body: ChatCompletionRequest, runner: CliRunner): void {
    this.armExecution();
    this.job = (async () => {
      try {
        for await (const text of runner.run({
          model: this.model.slice(this.model.indexOf('/') + 1), prompt: formatPrompt(body.messages),
          signal: this.controller.signal, ...(body.tools ? { tools: body.tools } : {}),
          onApproval: request => this.wait<boolean>('approval', token => {
            if (body.tools?.some(tool => tool.function.name === APPROVAL_TOOL)) {
              return { type: 'tool', call: { id: `call_${token}`, type: 'function', function: { name: APPROVAL_TOOL, arguments: JSON.stringify(request) } } };
            }
            return { type: 'approval', text: authorizationPrompt(request, token) };
          }),
          onToolCall: call => this.wait<string>('tool', () => ({ type: 'tool', call })),
        })) {
          if (!this.terminal) this.events.push({ type: 'text', text });
        }
        if (!this.terminal) { this.terminal = true; this.events.push({ type: 'end' }); }
      } catch (error) {
        if (!this.terminal) {
          this.terminal = true;
          this.events.push({ type: 'error', error: error instanceof Error ? error : new Error(String(error)) });
        }
      } finally {
        clearTimeout(this.timer);
        this.pending?.reject(new ProxyError('The CLI session ended before authorization was answered.', 410, 'approval_expired'));
        this.pending = undefined;
        this.remove();
      }
    })();
  }

  resolve(value: boolean | string, body: ChatCompletionRequest): void {
    const pending = this.pending;
    if (!pending) throw new ProxyError('This action is no longer pending.', 409, 'approval_not_pending');
    this.pending = undefined;
    this.contextHash = transcriptHash(body.messages);
    this.armExecution();
    pending.resolve(value);
  }

  cancel(error: Error): void {
    if (this.terminal) return;
    this.terminal = true;
    clearTimeout(this.timer);
    this.controller.abort(error);
    this.pending?.reject(error);
    this.pending = undefined;
    this.events.push({ type: 'error', error });
  }
}

export class SessionManager {
  private sessions = new Map<string, AgentSession>();
  constructor(private timeoutMs = 120_000, private approvalMs = 300_000, private maxSessions = 32) {}

  get size(): number { return this.sessions.size; }

  acquire(body: ChatCompletionRequest, runner: CliRunner, authorization = ''): AgentSession {
    const model = canonicalModel(body.model);
    const principal = hash([authorization, body.user ?? '', body.conversation_id ?? '']);
    const last = body.messages.at(-1);
    let assistantIndex = body.messages.length - 2;
    while (assistantIndex >= 0 && body.messages[assistantIndex]?.role !== 'assistant') assistantIndex--;
    const assistant = body.messages[assistantIndex];
    const token = /<!-- cli-proxy-approval:([a-f0-9]+\.[a-f0-9]+) -->/.exec(messageText(assistant))?.[1];
    let session: AgentSession | undefined;
    if (token) session = this.sessions.get(token.split('.')[0]!);
    else if (last?.role === 'tool') session = [...this.sessions.values()].find(item => item.pending?.callId === last.tool_call_id && item.model === model && item.principal === principal);

    if (token || last?.role === 'tool') {
      if (!session || !session.pending) throw new ProxyError('Pending action expired or was already answered. Submit the original request again.', 410, 'approval_expired');
      if (session.model !== model || session.principal !== principal || session.contextHash !== transcriptHash(body.messages.slice(0, assistantIndex))) {
        throw new ProxyError('Pending action does not belong to this conversation or model.', 409, 'approval_context_mismatch');
      }
      if ((token && session.pending.token !== token) || session.busy) throw new ProxyError('This pending action was already claimed.', 409, 'approval_conflict');
      if (last?.role === 'tool') {
        if (session.pending.callId !== last.tool_call_id || !assistant?.tool_calls?.some(call => call.id === last.tool_call_id)) throw new ProxyError('Tool call ID does not match the pending action.', 409, 'approval_context_mismatch');
        if (session.pending.kind === 'approval') {
          let decision = approvalDecision(messageText(last));
          try {
            const output = JSON.parse(messageText(last));
            if (typeof output.approved === 'boolean') decision = output.approved;
          } catch { /* Plain language aliases are also accepted. */ }
          if (decision === undefined) throw new ProxyError('Approval tool output must contain {"approved":true|false}.', 400, 'invalid_request_error');
          session.resolve(decision, body);
        } else session.resolve(messageText(last), body);
      } else {
        if (last?.role !== 'user' || session.pending.kind !== 'approval') throw new ProxyError('A matching tool response is required.', 409, 'approval_context_mismatch');
        const decision = approvalDecision(messageText(last));
        if (decision === undefined) {
          session.contextHash = transcriptHash(body.messages);
          session.events.push(session.pending.event);
        } else session.resolve(decision, body);
      }
    } else {
      if (last?.role === 'user' && approvalDecision(messageText(last)) !== undefined) throw new ProxyError('There is no pending approval in this conversation.', 409, 'approval_not_pending');
      if (this.sessions.size >= this.maxSessions) throw new ProxyError('Too many active or pending CLI sessions.', 503, 'session_limit');
      session = new AgentSession(model, principal, body, this.timeoutMs, this.approvalMs, () => this.sessions.delete(session!.id));
      this.sessions.set(session.id, session);
      session.start(body, runner);
    }
    session.busy = true;
    return session;
  }

  async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    for (const session of sessions) session.cancel(new ProxyError('Server is shutting down.', 503, 'server_shutdown'));
    await Promise.all(sessions.map(session => session.job));
    this.sessions.clear();
  }
}
