// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import type { Marker } from '@shared/types';
import { MarkerPrompt } from '../../src/renderer/src/components/MarkerPrompt';

const marker = (id: string, type: Marker['type'] = 2, t = 151_420): Marker => ({ id, momentId: 'm', epoch: 0, type, sourceTimeMs: t, comment: '' });
const field = () => screen.getByPlaceholderText('Комментарий к моменту…') as HTMLInputElement;

test('ничего не рисует без маркера', () => {
  const { container } = render(<MarkerPrompt marker={null} onSubmit={() => {}} onCancel={() => {}} />);
  expect(container.innerHTML).toBe('');
});

test('показывает тип, таймкод 02:31.420 и фокусирует поле', () => {
  render(<MarkerPrompt marker={marker('a')} onSubmit={() => {}} onCancel={() => {}} />);
  expect(screen.getByText('Новый маркер')).toBeTruthy();
  expect(screen.getByText('02:31.420')).toBeTruthy();
  expect(screen.getByTestId('marker-type').textContent).toBe('2');
  expect(screen.getByText('Enter — сохранить без комментария')).toBeTruthy();
  expect(document.activeElement).toBe(field());
});

test('Enter с пустым полем → onSubmit(id, "")', () => {
  const onSubmit = vi.fn();
  render(<MarkerPrompt marker={marker('a')} onSubmit={onSubmit} onCancel={() => {}} />);
  fireEvent.keyDown(field(), { key: 'Enter' });
  expect(onSubmit.mock.calls).toEqual([['a', '']]);
});

test('Enter с текстом → onSubmit(id, "текст")', () => {
  const onSubmit = vi.fn();
  render(<MarkerPrompt marker={marker('a')} onSubmit={onSubmit} onCancel={() => {}} />);
  fireEvent.change(field(), { target: { value: 'текст' } });
  fireEvent.keyDown(field(), { key: 'Enter' });
  expect(onSubmit.mock.calls).toEqual([['a', 'текст']]);
});

test('Esc → onCancel(id), onSubmit не вызывается', () => {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  render(<MarkerPrompt marker={marker('a')} onSubmit={onSubmit} onCancel={onCancel} />);
  fireEvent.change(field(), { target: { value: 'черновик' } });
  fireEvent.keyDown(field(), { key: 'Escape' });
  expect(onCancel.mock.calls).toEqual([['a']]);
  expect(onSubmit).not.toHaveBeenCalled();
});

test('цифры, набранные в поле, попадают в текст комментария', () => {
  const onSubmit = vi.fn();
  render(<MarkerPrompt marker={marker('a')} onSubmit={onSubmit} onCancel={() => {}} />);
  fireEvent.change(field(), { target: { value: '2 из 3' } });
  expect(field().value).toBe('2 из 3');
  expect(onSubmit).not.toHaveBeenCalled();
});

test('смена marker при непустом поле → onSubmit(старыйId, набранныйТекст), поле очищено для нового', () => {
  const onSubmit = vi.fn();
  const { rerender } = render(<MarkerPrompt marker={marker('a')} onSubmit={onSubmit} onCancel={() => {}} />);
  fireEvent.change(field(), { target: { value: 'первый' } });
  rerender(<MarkerPrompt marker={marker('b', 5, 200_000)} onSubmit={onSubmit} onCancel={() => {}} />);
  expect(onSubmit.mock.calls).toEqual([['a', 'первый']]);
  expect(field().value).toBe('');
  expect(screen.getByTestId('marker-type').textContent).toBe('5');
  expect(screen.getByText('03:20.000')).toBeTruthy();
  fireEvent.keyDown(field(), { key: 'Enter' });
  expect(onSubmit.mock.calls).toEqual([['a', 'первый'], ['b', '']]);
});

test('смена marker при пустом поле не вызывает onSubmit', () => {
  const onSubmit = vi.fn();
  const { rerender } = render(<MarkerPrompt marker={marker('a')} onSubmit={onSubmit} onCancel={() => {}} />);
  rerender(<MarkerPrompt marker={marker('b')} onSubmit={onSubmit} onCancel={() => {}} />);
  expect(onSubmit).not.toHaveBeenCalled();
});
