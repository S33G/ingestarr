// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import { CopyableValue } from './util-ui';

afterEach(cleanup);

it('copies the complete value and announces success', async () => {
  const copyText = vi.fn().mockResolvedValue({ ok: true });
  window.ingestarr = { copyText } as never;
  const value = 'sha256:0123456789abcdef0123456789abcdef';

  render(<CopyableValue value={value} label="Checksum" />);
  await userEvent.click(screen.getByRole('button', { name: 'Copy Checksum' }));

  expect(copyText).toHaveBeenCalledWith(value);
  expect(screen.getByRole('status')).toHaveTextContent('Copied');
  expect(screen.getByText(value)).toHaveAttribute('title', value);
});
