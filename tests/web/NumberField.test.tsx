// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FIELDS } from '../../src/service/profileSettings';
import { NumberField } from '../../src/web/components/NumberField';

const SHARE = FIELDS.find((f) => f.path === 'detector.chat.minTriggerShare')!;
const PRE = FIELDS.find((f) => f.path === 'cut.preRollMs')!;
const SPIKE = FIELDS.find((f) => f.path === 'detector.chat.minSpike')!;
afterEach(cleanup);
const view = (over: Partial<Parameters<typeof NumberField>[0]> = {}) => {
  const onChange = vi.fn();
  const r = render(<NumberField def={SHARE} value="50" factory={0.5} onChange={onChange} {...over} />);
  return { onChange, ...r };
};
const slider = (label: string) => screen.getByLabelText(`${label}: ползунок`) as HTMLInputElement;

it('shows a share in percent on both controls', () => {
  view();
  expect((screen.getByLabelText(SHARE.label) as HTMLInputElement).value).toBe('50');
  expect([slider(SHARE.label).value, slider(SHARE.label).min, slider(SHARE.label).max, slider(SHARE.label).step]).toEqual(['50', '10', '100', '5']);
  expect(screen.getByText('%')).toBeTruthy();
});
it('reports the slider position as display text', () => {
  const { onChange } = view();
  fireEvent.change(slider(SHARE.label), { target: { value: '65' } });
  expect(onChange).toHaveBeenLastCalledWith('65');
});
it('shows milliseconds as seconds', () => {
  view({ def: PRE, value: '15', factory: 15000 });
  expect([slider(PRE.label).max, slider(PRE.label).step]).toEqual(['60', '1']);
  expect(screen.getByText('с')).toBeTruthy();
});
it('marks a value that differs from the factory one and restores it', () => {
  const { onChange, container } = view({ value: '70' });
  expect(container.querySelector('.dot')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'вернуть 50 %' }));
  expect(onChange).toHaveBeenLastCalledWith('50');
  cleanup();
  const same = view();
  expect(same.container.querySelector('.dot')).toBeNull();
  expect(screen.queryByRole('button', { name: /вернуть/ })).toBeNull();
});
it('says at once that a number is out of range, in display units', () => {
  view({ value: '250' });
  expect(screen.getByText('«Состав: триггерных сообщений, не меньше»: допустимо от 1 до 100')).toBeTruthy();
});
it('prefers the error it is given and stays quiet on an empty field', () => {
  view({ value: '', error: 'ошибка сервера' });
  expect(screen.getByText('ошибка сервера')).toBeTruthy();
  cleanup();
  const { container } = view({ value: '' });
  expect(container.querySelector('.error')).toBeNull();
  expect(container.innerHTML).not.toContain('NaN');
});
it('keeps the hint behind the question mark', () => {
  view({ def: SPIKE, value: '2', factory: 2 });
  expect(screen.queryByText(/Первое условие/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: `Подсказка: ${SPIKE.label}` }));
  expect(screen.getByText(/Первое условие.*со следующей секунды/)).toBeTruthy();
});
