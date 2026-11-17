// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FIELDS } from '../../src/service/profileSettings';
import { ThresholdChart } from '../../src/web/components/ThresholdChart';

const SPIKE = FIELDS.find((f) => f.path === 'detector.chat.minSpike')!;
const SHARE = FIELDS.find((f) => f.path === 'detector.chat.minTriggerShare')!;
afterEach(cleanup);

const view = (over: Partial<Parameters<typeof ThresholdChart>[0]> = {}) => {
  const onChange = vi.fn();
  const r = render(<ThresholdChart label="Скорость чата" values={[1, 2, 3]} marks={[2]} threshold={2} savedThreshold={2} def={SPIKE} onChange={onChange} {...over} />);
  return { onChange, ...r };
};
const slider = () => screen.getByRole('slider', { name: 'Скорость чата: порог' });

it('moves the threshold by one step with the arrow keys', () => {
  const { onChange } = view();
  fireEvent.keyDown(slider(), { key: 'ArrowUp' });
  expect(onChange).toHaveBeenLastCalledWith(2.1);
  fireEvent.keyDown(slider(), { key: 'ArrowDown' });
  expect(onChange).toHaveBeenLastCalledWith(1.9);
});
it('stops at the field maximum and at the given bounds', () => {
  const top = view({ threshold: 20, savedThreshold: 20 });
  fireEvent.keyDown(slider(), { key: 'ArrowUp' });
  expect(top.onChange).toHaveBeenLastCalledWith(20);
  cleanup();
  const bounded = view({ threshold: 1.5, min: 1.5, max: 5.5 });
  fireEvent.keyDown(slider(), { key: 'ArrowDown' });
  expect(bounded.onChange).toHaveBeenLastCalledWith(1.5);
  fireEvent.click(screen.getByRole('button', { name: 'Скорость чата: меньше' }));
  expect(bounded.onChange).toHaveBeenLastCalledWith(1.5);
});
it('takes an exact number from the input and ignores text that is not a number', () => {
  const { onChange } = view();
  const input = screen.getByLabelText('Скорость чата: значение порога') as HTMLInputElement;
  expect(input.value).toBe('2');
  fireEvent.change(input, { target: { value: 'abc' } });
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: '3,5' } });
  expect(onChange).toHaveBeenLastCalledWith(3.5);
  fireEvent.change(input, { target: { value: '2,25' } });
  expect(onChange).toHaveBeenLastCalledWith(2.25); // a typed value is not snapped to the slider step
});
it('does not fight the typing of a number that is out of range on the way: it is fitted on blur or Enter', () => {
  const { onChange } = view({ min: 1.5, max: 5.9 });
  const input = screen.getByLabelText('Скорость чата: значение порога') as HTMLInputElement;
  fireEvent.change(input, { target: { value: '1' } }); // on the way to 1,8
  expect(onChange).not.toHaveBeenCalled();
  expect(input.value).toBe('1');
  fireEvent.change(input, { target: { value: '1,8' } });
  expect(onChange).toHaveBeenLastCalledWith(1.8);
  fireEvent.change(input, { target: { value: '999' } });
  expect(onChange).toHaveBeenCalledTimes(1);
  fireEvent.blur(input);
  expect(onChange).toHaveBeenLastCalledWith(5.9);
  fireEvent.change(input, { target: { value: '0,2' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onChange).toHaveBeenLastCalledWith(1.5);
});
it('grows the scale with the data up to twice the slider range', () => {
  const y = (values: number[]) => Number(view({ values }).container.querySelector('.threshold')!.getAttribute('y1'));
  expect(y([1, 9])).toBeCloseTo(72 - (2 / 9) * 72, 1);   // top = 9
  cleanup();
  expect(y([1, 39])).toBeCloseTo(72 - (2 / 12) * 72, 1); // top capped at 2 × 6
  cleanup();
  expect(y([])).toBeCloseTo(72 - (2 / 6) * 72, 1);       // no data: the slider range
});
it('shows a share in percent and stores a fraction', () => {
  const { onChange } = view({ label: 'Состав', def: SHARE, threshold: 0.5, savedThreshold: 0.5, values: [0.2, 0.8] });
  const input = screen.getByLabelText('Состав: значение порога') as HTMLInputElement;
  expect(input.value).toBe('50');
  fireEvent.change(input, { target: { value: '65' } });
  expect(onChange).toHaveBeenLastCalledWith(0.65);
  expect(screen.getByRole('slider', { name: 'Состав: порог' }).getAttribute('aria-valuetext')).toBe('50 %');
});
it('draws one mark per firing and a dashed line for the saved threshold when it differs', () => {
  const { container } = view({ threshold: 3, savedThreshold: 2, marks: [0, 2] });
  expect(container.querySelectorAll('.mark')).toHaveLength(2);
  expect(container.querySelector('.saved')).toBeTruthy();
  cleanup();
  expect(view().container.querySelector('.saved')).toBeNull();
});
it('renders an empty chart without NaN', () => {
  const { container } = view({ values: [], marks: [] });
  expect(container.innerHTML).not.toContain('NaN');
  cleanup();
  expect(view({ values: [NaN, Infinity], marks: [5] }).container.innerHTML).not.toContain('NaN');
});
it('keeps the threshold reachable when one huge value (the warm-up burst) is on the chart', () => {
  const { container } = view({ values: [1, 39, 1.2, 1.1] });
  const y = Number(container.querySelector('.threshold')!.getAttribute('y1'));
  expect(y).toBeLessThan(72 * 0.9); // with the scale topped by ×39 the ×2 line would sit at the very bottom
});
