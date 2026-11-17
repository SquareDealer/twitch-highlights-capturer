// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PatternChips } from '../../src/web/components/PatternChips';

afterEach(cleanup);
const view = (over: Partial<Parameters<typeof PatternChips>[0]> = {}) => {
  const onChange = vi.fn();
  const r = render(<PatternChips label="Смех" patterns={['^lol$', '^kek$']} bad={[]} onChange={onChange} {...over} />);
  return { onChange, ...r };
};
const input = () => screen.getByLabelText('Смех: добавить шаблон') as HTMLInputElement;

it('lists the patterns as chips inside a labelled group', () => {
  const { container } = view();
  expect(screen.getByRole('group', { name: 'Смех' })).toBeTruthy();
  expect([...container.querySelectorAll('.chip')].map((c) => c.textContent)).toEqual(['^lol$×', '^kek$×']);
});
it('adds a trimmed pattern on Enter and clears the input', () => {
  const { onChange } = view();
  fireEvent.change(input(), { target: { value: '  ^ору+$ ' } });
  fireEvent.keyDown(input(), { key: 'Enter' });
  expect(onChange).toHaveBeenLastCalledWith(['^lol$', '^kek$', '^ору+$']);
  expect(input().value).toBe('');
});
it('ignores a duplicate and an empty line', () => {
  const { onChange } = view();
  fireEvent.change(input(), { target: { value: '^lol$' } });
  fireEvent.keyDown(input(), { key: 'Enter' });
  fireEvent.change(input(), { target: { value: '   ' } });
  fireEvent.keyDown(input(), { key: 'Enter' });
  expect(onChange).not.toHaveBeenCalled();
});
it('removes a pattern', () => {
  const { onChange } = view();
  fireEvent.click(screen.getByRole('button', { name: 'Удалить ^lol$' }));
  expect(onChange).toHaveBeenLastCalledWith(['^kek$']);
});
it('marks the patterns the detector does not use', () => {
  const { container } = view({ bad: ['^kek$'] });
  const chip = [...container.querySelectorAll('.chip')][1]!;
  expect(chip.className).toContain('bad');
  expect(chip.getAttribute('title')).toBe('не используется детектором');
});
it('shows an error', () => {
  view({ error: '«Смех»: неверный шаблон: ((' });
  expect(screen.getByText('«Смех»: неверный шаблон: ((')).toBeTruthy();
});
