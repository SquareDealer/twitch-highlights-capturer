// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import type { DetectorDetail } from '../../src/service/detectorProcess';
import { TriggerChain } from '../../src/web/components/TriggerChain';

const T = { minSpike: 2, minTriggerShare: 0.5, minTriggerMessages: 3, minTriggerAuthors: 2 };
const detail = (chat: Partial<DetectorDetail['chat']> = {}, warm = true): DetectorDetail => ({
  configVersion: 1, sinceStartMs: 30000,
  chat: { messages: 13, authors: 9, baseline: 5, spike: 2.6, triggerMessages: 5, triggerAuthors: 4, laughMessages: 4, reactionMessages: 1, triggerShare: 0.385, ...chat },
  conditions: { warm, spike: true, messages: true, authors: true, share: false, fired: false },
  audio: { db: -20, baselineDb: -27, deltaDb: 7, vad: 0.82, warm: true, spiking: false },
  score: { total: 1, share: 0, speed: 0, audio: 0 }, event: null,
});
afterEach(cleanup);
const step = (name: string) => screen.getByText(name).closest('.chain-step')!;

it('shows the three steps with values and thresholds', () => {
  render(<TriggerChain detail={detail()} draft={T} saved={T} warmupS={60} />);
  expect(step('Всплеск').textContent).toContain('×2,6');
  expect(step('Всплеск').textContent).toContain('нужно ≥ ×2');
  expect(step('Всплеск').className).toContain('ok');
  expect(step('Состав').textContent).toContain('38,5 %');
  expect(step('Состав').textContent).toContain('5 из 13 · авторов 4');
  expect(step('Состав').className).toContain('bad');
  expect(step('Звук').textContent).toContain('+7 дБ');
  expect(screen.getByText('не сработало: не хватает состава')).toBeTruthy();
});
it('dims the composition step until the spike is there', () => {
  render(<TriggerChain detail={detail({ spike: 1.4 })} draft={T} saved={T} warmupS={60} />);
  expect(step('Всплеск').className).toContain('bad');
  expect(step('Состав').className).toContain('dim');
});
it('judges by the draft thresholds and says so', () => {
  render(<TriggerChain detail={detail()} draft={{ ...T, minTriggerShare: 0.3 }} saved={T} warmupS={60} />);
  expect(step('Состав').className).toContain('ok');
  expect(step('Состав').textContent).toContain('нужно ≥ 30 %');
  expect(screen.getByText('сработало бы с этими порогами')).toBeTruthy();
});
it('shows the warm-up row only while warming up', () => {
  render(<TriggerChain detail={detail({}, false)} draft={T} saved={T} warmupS={60} />);
  expect(screen.getByText(/прогрев: идёт 30 с, нужно 60 с/)).toBeTruthy();
  cleanup();
  render(<TriggerChain detail={detail()} draft={T} saved={T} warmupS={60} />);
  expect(screen.queryByText(/прогрев/)).toBeNull();
});
it('survives an empty window', () => {
  const { container } = render(<TriggerChain detail={detail({ messages: 0, triggerMessages: 0, triggerAuthors: 0, triggerShare: 0, spike: 0, baseline: 0 })} draft={T} saved={T} warmupS={60} />);
  expect(container.innerHTML).not.toContain('NaN');
});
