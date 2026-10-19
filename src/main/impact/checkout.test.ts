import { chmod, mkdir, mkdtemp, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripExecutableBits } from './checkout';

describe('stripExecutableBits', () => {
  it('clears execute bits on files inside the checkout but never follows links out of it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pr-lens-checkout-'));
    const outside = join(await mkdtemp(join(tmpdir(), 'pr-lens-outside-')), 'tool');
    await writeFile(outside, '#!/bin/sh\n');
    await chmod(outside, 0o755);
    await mkdir(join(root, '.venv/bin'), { recursive: true });
    await writeFile(join(root, '.venv/bin/python'), '#!/bin/sh\n');
    await chmod(join(root, '.venv/bin/python'), 0o755);
    await writeFile(join(root, 'main.go'), 'package main\n');
    await symlink(outside, join(root, 'link'));

    await stripExecutableBits(root);

    expect((await stat(join(root, '.venv/bin/python'))).mode & 0o777).toBe(0o644);
    expect((await stat(join(root, 'main.go'))).mode & 0o111).toBe(0);
    expect((await stat(outside)).mode & 0o777).toBe(0o755);
  });
});
