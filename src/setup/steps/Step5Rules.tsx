import { RulesSetup } from '../types';
import { SETUP_USAGE, usageChipLabel } from '../usage';

type Strength = '必ず守る' | 'できるだけ守る（作れないときは外す）' | 'なるべく守る';

interface FixedRuleRow {
  text: string;
  strength: Strength;
  editStep?: { step: number; label: string };
}

const STRENGTH_CHIP: Record<Strength, string> = {
  必ず守る: 'chip-hard',
  'できるだけ守る（作れないときは外す）': 'chip-mid',
  なるべく守る: 'chip-soft',
};

const OTHER_RULES: FixedRuleRow[] = [
  {
    text: '勤務帯ごとの人数は、人数の画面で決めた毎日の必要人数ちょうどにする',
    strength: '必ず守る',
    editStep: { step: 3, label: '人数を直す' },
  },
  {
    text: '入れない曜日を設定した職員は、その日に入れない',
    strength: '必ず守る',
    editStep: { step: 4, label: '職員を直す' },
  },
  {
    text: '連続勤務は5日まで',
    strength: '必ず守る',
  },
  {
    text: '夜勤の翌日は休み（夜勤明け）にする',
    strength: '必ず守る',
  },
  {
    text: '遅番の翌日に早番を入れない',
    strength: '必ず守る',
  },
  {
    text: '連続勤務の5日に、夜勤明けの日も数える',
    strength: 'できるだけ守る（作れないときは外す）',
  },
  {
    text: '常勤は月8日以上休む（主任を除く）',
    strength: 'できるだけ守る（作れないときは外す）',
  },
  {
    text: '夜勤に医療的ケアができる人を2人以上（夜勤が2人以上のとき）',
    strength: 'なるべく守る',
  },
  {
    text: '夜勤回数の差は2回以内（できれば1回以内）',
    strength: 'なるべく守る',
  },
  {
    text: '常勤の勤務回数の差は4回以内（主任を除く）',
    strength: 'なるべく守る',
  },
  {
    text: 'パートは月14日まで',
    strength: 'なるべく守る',
  },
];

export function Step5Rules({
  data,
  onChange,
  onJumpStep,
}: {
  data: RulesSetup;
  onChange: (data: RulesSetup) => void;
  onJumpStep?: (step: number) => void;
}) {
  const setNightMax = (val: number) => {
    const clamped = Math.max(1, Math.min(15, Math.round(val)));
    onChange({ ...data, nightMax: clamped });
  };

  return (
    <div>
      <div className="step-head-row">
        <h2>シフト作成で守ることを確認してください</h2>
        {!SETUP_USAGE.rules && (
          <span className="chip-muted">{usageChipLabel(false)}</span>
        )}
      </div>
      <p className="setup-description">
        {SETUP_USAGE.rules
          ? 'いまのシフト作成で使われるルールの一覧です。夜勤の上限回数だけはここで変えられます（既定の仮の値は8回です）。'
          : 'シフト作成につないだあとに使われるルールの一覧です。夜勤の上限回数だけはここで変えられます（既定の仮の値は8回です）。いまはまだシフト作成に使っていません。'}
      </p>

      <ul className="rule-legend">
        <li><span className="chip-hard">必ず守る</span> 守れないときは表を作りません</li>
        <li><span className="chip-mid">できるだけ守る（作れないときは外す）</span> まず守って作り、作れなければ外して作り直します</li>
        <li><span className="chip-soft">なるべく守る</span> 表を作るために、守れないことがあります</li>
      </ul>

      <div className="rule-list">
        {/* 変えられるルール：夜勤上限 */}
        <div className="rule-row editable">
          <div className="rule-row-left">
            <div className="rule-badges">
              <span className="chip-hard">必ず守る</span>
              <span className="chip-active">ここで変えられます</span>
            </div>
            <div className="rule-text">
              夜勤は月 <strong>{data.nightMax}</strong> 回まで（1〜15回）
            </div>
          </div>

          <div className="rule-row-right">
            <div className="need-stepper">
              <button
                type="button"
                className="stepper-btn"
                disabled={data.nightMax <= 1}
                onClick={() => setNightMax(data.nightMax - 1)}
                aria-label="夜勤の上限を1回減らす"
              >
                −
              </button>
              <input
                type="number"
                min={1}
                max={15}
                className="need-input"
                value={data.nightMax}
                aria-label="夜勤の月間上限回数"
                onInput={(e) => {
                  const n = parseInt((e.target as HTMLInputElement).value, 10);
                  setNightMax(Number.isNaN(n) ? 1 : n);
                }}
              />
              <span className="need-unit-label">回</span>
              <button
                type="button"
                className="stepper-btn"
                disabled={data.nightMax >= 15}
                onClick={() => setNightMax(data.nightMax + 1)}
                aria-label="夜勤の上限を1回増やす"
              >
                ＋
              </button>
            </div>
          </div>
        </div>

        {/* ほかのルール */}
        {OTHER_RULES.map((rule, idx) => {
          const isFixed = !rule.editStep;
          return (
            <div
              key={idx}
              className={`rule-row ${isFixed ? 'fixed' : ''}`}
            >
              <div className="rule-row-left">
                <div className="rule-badges">
                  <span className={STRENGTH_CHIP[rule.strength]}>
                    {rule.strength}
                  </span>
                </div>
                <div className="rule-text">{rule.text}</div>
              </div>

              <div className="rule-row-right">
                {rule.editStep && onJumpStep ? (
                  <button
                    type="button"
                    className="rule-link-btn"
                    onClick={() => onJumpStep(rule.editStep!.step)}
                  >
                    {rule.editStep.label}
                  </button>
                ) : (
                  <span className="rule-fixed-label">いまは固定</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p className="rule-footnote">
        施設ごとに変えられるようにするのは次の段階です。
      </p>
    </div>
  );
}
