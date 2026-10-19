import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { DiffModel } from '../../../shared/diff';
import { spawnStdio } from '../../exec/exec';
import type { SpawnStdio } from '../../exec/exec';
import { analyzeWithServer } from './analyze';
import { createRpc } from './rpc';

/**
 * A scripted language server: answers the requests the analyzer makes, asks the client for its
 * configuration, reports progress, and writes its frames in small pieces to exercise framing.
 */
const FAKE_SERVER = String.raw`
const root = process.argv[2];
const uri = (p) => 'file://' + root + '/' + p;
let buffer = Buffer.alloc(0);
let configReply = null;
const send = (msg) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }));
  const frame = Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n'), body]);
  for (let i = 0; i < frame.length; i += 7) process.stdout.write(frame.subarray(i, i + 7));
};
const item = (name, path, line) => ({
  name, kind: 12, uri: uri(path),
  range: { start: { line, character: 0 }, end: { line: line + 2, character: 1 } },
  selectionRange: { start: { line, character: 5 }, end: { line, character: 5 + name.length } },
});
const handle = (msg) => {
  if (msg.id !== undefined && msg.method === undefined) { configReply = msg.result; return; }
  switch (msg.method) {
    case 'initialize':
      send({ id: 99, method: 'workspace/configuration', params: { items: [{ section: 'python.analysis' }, {}] } });
      send({ method: '$/progress', params: { token: 't', value: { kind: 'begin', title: 'Loading' } } });
      setTimeout(() => send({ method: '$/progress', params: { token: 't', value: { kind: 'end' } } }), 50);
      return send({ id: msg.id, result: { capabilities: {} } });
    case 'textDocument/documentSymbol':
      return send({ id: msg.id, result: [{
        name: 'Holder', kind: 5,
        range: { start: { line: 0, character: 0 }, end: { line: 9, character: 0 } },
        selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } },
        children: [{
          name: 'changed', kind: 6,
          range: { start: { line: 2, character: 0 }, end: { line: 4, character: 1 } },
          selectionRange: { start: { line: 2, character: 5 }, end: { line: 2, character: 12 } },
        }],
      }] });
    case 'textDocument/prepareCallHierarchy':
      return send({ id: msg.id, result: [item('changed', 'pkg/a.py', 2)] });
    case 'callHierarchy/incomingCalls':
      return send({ id: msg.id, result: [
        { from: item('caller', 'tests/test_a.py', 4), fromRanges: [] },
        { from: item('configEcho:' + JSON.stringify(configReply), 'pkg/b.py', 0), fromRanges: [] },
      ] });
    case 'callHierarchy/outgoingCalls':
      return send({ id: msg.id, result: [
        { to: item('helper', 'pkg/a.py', 7), fromRanges: [] },
        { to: { ...item('stdlib', 'x', 0), uri: 'file:///usr/lib/python3/os.py' }, fromRanges: [] },
      ] });
    case 'shutdown':
      return send({ id: msg.id, result: null });
    case 'exit':
      return process.exit(0);
    default:
      if (msg.id !== undefined) send({ id: msg.id, result: null });
  }
};
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    handle(JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString()));
    buffer = buffer.subarray(end + 4 + length);
  }
});
`;

const diff: DiffModel = {
  files: [
    {
      fid: 'F1',
      path: 'pkg/a.py',
      status: 'modified',
      binary: false,
      additions: 1,
      deletions: 0,
      noise: null,
      hunks: [{ header: '@@', lines: [{ id: 'F1-001', kind: 'add', new: 4, text: '  x' }] }],
    },
  ],
};

const setup = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pr-lens-fake-lsp-')));
  await mkdir(join(root, 'pkg'));
  await writeFile(join(root, 'pkg/a.py'), 'class Holder:\n\n  def changed():\n    x\n\n');
  const script = join(await mkdtemp(join(tmpdir(), 'pr-lens-fake-server-')), 'server.cjs');
  await writeFile(script, FAKE_SERVER);
  return { root, script };
};

describe('analyzeWithServer', () => {
  it('builds the map from the call hierarchy and keeps only items inside the checkout', async () => {
    const { root, script } = await setup();
    const spawn: SpawnStdio = (req) =>
      spawnStdio({ ...req, file: process.execPath, args: [script, root] });
    const map = await analyzeWithServer({
      language: 'python',
      command: '/unused',
      root,
      env: { PATH: process.env.PATH },
      diff,
      scannedFiles: 2,
      spawn,
    });

    const byName = new Map(map.nodes.map((node) => [node.name, node]));
    const changed = byName.get('changed');
    expect(changed).toMatchObject({
      changed: true,
      path: 'pkg/a.py',
      startLine: 3,
      endLine: 5,
      anchorLineId: 'F1-001',
    });
    expect(byName.get('caller')?.test).toBe(true);
    expect(byName.has('stdlib')).toBe(false);
    // The server asked for configuration and got the preset's section, then null for the rest.
    expect(
      map.nodes.some(
        (node) =>
          node.name ===
          `configEcho:${JSON.stringify([{ diagnosticMode: 'openFilesOnly', autoSearchPaths: true }, null])}`,
      ),
    ).toBe(true);
    expect(map.edges).toEqual(
      expect.arrayContaining([
        { from: byName.get('caller')?.id, to: changed?.id },
        { from: changed?.id, to: byName.get('helper')?.id },
      ]),
    );
    expect(map.tests).toEqual([{ path: 'tests/test_a.py', relatedNodeIds: [changed?.id] }]);
    expect(map.scannedFiles).toBe(2);
  });

  it('names the server it could not start', async () => {
    const { root } = await setup();
    await expect(
      analyzeWithServer({
        language: 'go',
        command: join(root, 'no-such-gopls'),
        root,
        env: {},
        diff: { files: [{ ...diff.files[0]!, path: 'pkg/a.go' }] },
        scannedFiles: 1,
        spawn: spawnStdio,
      }),
    ).rejects.toThrow(/Could not run gopls/);
  });

  it('stops a server that never answers', async () => {
    const { root } = await setup();
    const spawn: SpawnStdio = (req) =>
      spawnStdio({ ...req, file: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] });
    await expect(
      analyzeWithServer({
        language: 'python',
        command: '/unused',
        root,
        env: {},
        diff,
        scannedFiles: 1,
        spawn,
        timeoutMs: 300,
      }),
    ).rejects.toThrow(/took too long/);
  });
});

describe('createRpc', () => {
  it('reads frames split anywhere, with multi-byte bodies, and replies to server requests', async () => {
    const fromServer = new PassThrough();
    const toServer = new PassThrough();
    const rpc = createRpc(fromServer, toServer);
    rpc.onRequest((method) => (method === 'ping' ? 'pong' : null));
    const written: string[] = [];
    toServer.on('data', (chunk: Buffer) => written.push(chunk.toString()));

    const answer = rpc.request<string>('hello', {});
    const frame = (msg: object): Buffer => {
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }));
      return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
    };
    const bytes = Buffer.concat([
      frame({ id: 1, result: 'héllo ✓' }),
      frame({ id: 7, method: 'ping' }),
    ]);
    for (let i = 0; i < bytes.length; i += 3) fromServer.write(bytes.subarray(i, i + 3));
    await expect(answer).resolves.toBe('héllo ✓');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(written.join('')).toContain('"id":7,"result":"pong"');

    const late = rpc.request('never', {});
    rpc.close('gone');
    await expect(late).rejects.toThrow('gone');
  });
});
