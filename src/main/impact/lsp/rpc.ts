import type { Readable, Writable } from 'node:stream';

/** A server message larger than this ends the session rather than growing the buffer. */
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const HEADER_END = Buffer.from('\r\n\r\n');

export class RpcError extends Error {
  override name = 'RpcError';
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Rpc {
  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
  notify(method: string, params: unknown): void;
  /** Answers requests the server sends us. A thrown error becomes a JSON-RPC error reply. */
  onRequest(handler: (method: string, params: unknown) => unknown): void;
  onNotification(handler: (method: string, params: unknown) => void): void;
  /** Rejects every pending request; later calls fail straight away. */
  close(reason: string): void;
}

interface Message {
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/** JSON-RPC 2.0 over LSP's `Content-Length` framing. */
export function createRpc(input: Readable, output: Writable): Rpc {
  let nextId = 1;
  let closed: string | null = null;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  let requestHandler: (method: string, params: unknown) => unknown = () => null;
  let notificationHandler: (method: string, params: unknown) => void = () => undefined;

  const send = (message: object): void => {
    if (closed) return;
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
    output.write(`Content-Length: ${body.length}\r\n\r\n`);
    output.write(body);
  };

  const close = (reason: string): void => {
    if (closed) return;
    closed = reason;
    for (const [, call] of pending) {
      clearTimeout(call.timer);
      call.reject(new RpcError(-32099, reason));
    }
    pending.clear();
  };

  const dispatch = (message: Message): void => {
    if (message.method !== undefined && message.id !== undefined) {
      const { id, method } = message;
      Promise.resolve()
        .then(() => requestHandler(method, message.params))
        .then(
          (result) => send({ id, result: result ?? null }),
          (err: unknown) =>
            send({
              id,
              error: { code: -32603, message: err instanceof Error ? err.message : 'failed' },
            }),
        );
    } else if (message.method !== undefined) {
      notificationHandler(message.method, message.params);
    } else if (typeof message.id === 'number') {
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.error) call.reject(new RpcError(message.error.code, message.error.message));
      else call.resolve(message.result);
    }
  };

  let buffer = Buffer.alloc(0);
  input.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf(HEADER_END);
      if (headerEnd < 0) {
        if (buffer.length > 8192) close('The language server sent a malformed header.');
        return;
      }
      const length = Number(
        /content-length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'))?.[1],
      );
      if (!Number.isSafeInteger(length) || length > MAX_MESSAGE_BYTES) {
        close('The language server sent a message PR Lens does not accept.');
        return;
      }
      const start = headerEnd + HEADER_END.length;
      if (buffer.length < start + length) return;
      const body = buffer.subarray(start, start + length).toString('utf8');
      buffer = buffer.subarray(start + length);
      try {
        dispatch(JSON.parse(body) as Message);
      } catch {
        // One unparseable message is skipped; the framing is still intact.
      }
    }
  });
  input.on('close', () => close('The language server exited.'));

  return {
    request<T>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
      if (closed) return Promise.reject(new RpcError(-32099, closed));
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new RpcError(-32001, `${method} timed out`));
        }, timeoutMs);
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
        send({ id, method, params });
      });
    },
    notify: (method, params) => send({ method, params }),
    onRequest(handler) {
      requestHandler = handler;
    },
    onNotification(handler) {
      notificationHandler = handler;
    },
    close,
  };
}
