const W = 300;
const H = 40;

export function Sparkline({ values, max, threshold, label }: { values: number[]; max: number; threshold: number; label: string }) {
  const top = max > 0 ? max : 1;
  const y = (v: number) => H - Math.max(0, Math.min(1, v / top)) * H;
  const step = values.length > 1 ? W / (values.length - 1) : 0;
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return (
    <svg className="sparkline" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <line className="threshold" x1="0" x2={W} y1={y(threshold)} y2={y(threshold)} />
      {values.length > 0 && <polyline className="line" fill="none" points={points} />}
    </svg>
  );
}
