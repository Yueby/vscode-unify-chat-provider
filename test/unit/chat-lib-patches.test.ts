import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHAT_LIB_DIFF_PATCHED_SOURCE_PATHS,
  patchChatLibDiffSource,
} from '../../scripts/chat-lib-diff-patches';
import { patchChatLibParserSource } from '../../scripts/chat-lib-parser-patches';

const cases = [
  ...CHAT_LIB_DIFF_PATCHED_SOURCE_PATHS.map((filePath) => ({
    name: relative(process.cwd(), filePath),
    filePath,
    patch: patchChatLibDiffSource,
  })),
  ...[
    'src/chat-lib/upstream/extension/completions-core/vscode-node/lib/src/ghostText/blockTrimmer.ts',
    'src/chat-lib/upstream/extension/completions-core/vscode-node/prompt/src/parseBlock.ts',
  ].map((filePath) => ({
    name: filePath,
    filePath: resolve(filePath),
    patch: patchChatLibParserSource,
  })),
];

describe('chat-lib source patches', () => {
  it.each(cases)('patches LF and CRLF identically: $name', async ({ filePath, patch }) => {
    const source = (await readFile(filePath, 'utf8')).replace(/\r\n/g, '\n');
    const expected = patch(filePath, source);

    expect(expected).not.toBe(source);
    expect(patch(filePath, source.replace(/\n/g, '\r\n'))).toBe(expected);
  });

  it.each(cases)('rejects missing or ambiguous anchors: $name', async ({ filePath, patch }) => {
    const source = await readFile(filePath, 'utf8');

    expect(() => patch(filePath, '')).toThrow(/missing or ambiguous/);
    expect(() => patch(filePath, `${source}\r\n${source}`)).toThrow(/missing or ambiguous/);
  });

  it.each([patchChatLibDiffSource, patchChatLibParserSource])(
    'preserves source outside the patched paths',
    (patch) => {
      const source = 'export const value = true;\r\n';
      expect(patch(resolve('unrelated.ts'), source)).toBe(source);
    },
  );
});
