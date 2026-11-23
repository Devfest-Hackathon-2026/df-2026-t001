import { useState } from 'preact/hooks';
import { STEP_INFOS, SetupState } from './types';
import {
  alignAllNeedToUnits,
  applyShiftPreset,
  renameShiftId,
  updateFacility,
  updateNeedPerShift,
  updateRules,
  updateShifts,
  updateWeekdayNeed,
} from './mutations';
import { STORAGE_KEY, loadSetupState, resetSetupState, saveSetupState } from './storage';
import { Step0Intro } from './steps/Step0Intro';
import { Step1Facility } from './steps/Step1Facility';
import { Step2Shifts } from './steps/Step2Shifts';
import { Step3Need } from './steps/Step3Need';
import { Step4Staff } from './steps/Step4Staff';
import { Step5Rules } from './steps/Step5Rules';
import { Step6CarryIn } from './steps/Step6CarryIn';
import { Step7Verify } from './steps/Step7Verify';

type ReturnTarget = 'settings' | 'plan' | 'people';

const FROM_CONFIG: Record<ReturnTarget, { label: string; open: string }> = {
  settings: { label: '設定へ戻る', open: 'settings' },
  plan: { label: 'シフト作成へ戻る', open: 'plan' },
  people: { label: '職員へ戻る', open: 'people' },
};

function parseSetupQuery(): { step: number | null; from: ReturnTarget | null } {
  if (typeof window === 'undefined') return { step: null, from: null };
  const params = new URLSearchParams(window.location.search);
  const rawStep = params.get('step')?.trim() ?? '';
  const step = /^[1-7]$/.test(rawStep) ? Number(rawStep) : null;
  const rawFrom = params.get('from');
  const from: ReturnTarget | null =
    rawFrom === 'settings' || rawFrom === 'plan' || rawFrom === 'people' ? rawFrom : null;
  return { step, from };
}

export function App() {
  const [query] = useState(() => parseSetupQuery());
  const [state, setState] = useState<SetupState>(() => {
    const loaded = loadSetupState();
    return query.step !== null ? { ...loaded, currentStep: query.step } : loaded;
  });
  const [saveMessage, setSaveMessage] = useState<string>('保存済み');

  const currentStep = state.currentStep;

  // 状態変更時に自動保存
  const updateState = (updater: (prev: SetupState) => SetupState) => {
    setState((prev) => {
      const next = updater(prev);
      saveSetupState(next);
      return next;
    });
    setSaveMessage('保存済み');
  };

  const setStep = (step: number) => {
    updateState((prev) => ({ ...prev, currentStep: step }));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleNext = () => {
    if (currentStep < 7) {
      setStep(currentStep + 1);
    }
  };

  const handleBack = () => {
    if (currentStep > 0) {
      setStep(currentStep - 1);
    }
  };

  const handleReturnToLeader = () => {
    const hasSaved = (() => {
      try {
        return localStorage.getItem(STORAGE_KEY) !== null;
      } catch {
        return false;
      }
    })();
    const open = query.from ? FROM_CONFIG[query.from].open : null;
    if (hasSaved) {
      saveSetupState(state);
      window.location.href = open ? `./index.html?open=${open}` : './';
      return;
    }
    window.location.href = open ? `./index.html?demo&open=${open}` : './?demo';
  };

  const handleFinishToLeader = () => {
    saveSetupState(state);
    const open = query.from ? FROM_CONFIG[query.from].open : null;
    window.location.href = open ? `./index.html?open=${open}` : './';
  };

  const handleReset = () => {
    if (window.confirm('入力内容を初期状態（仮の値）に戻しますか？これまでの変更は失われます。')) {
      const fresh = resetSetupState();
      setState(fresh);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const backLabel = query.from ? FROM_CONFIG[query.from].label : 'リーダー画面へ戻る';

  return (
    <div className="setup-container">
      {/* Header */}
      <header className="setup-header">
        <div className="setup-brand">
          <h1 className="setup-title">助っ人ケア</h1>
          <span className="setup-badge">はじめの設定</span>
        </div>
        <div className="setup-header-right">
          <div className="setup-status">
            <span className="status-dot"></span>
            <span>{saveMessage}</span>
          </div>
          {(currentStep > 0 || query.from !== null) && (
            <button
              type="button"
              className="btn btn-outline btn-header-back"
              onClick={handleReturnToLeader}
            >
              {backLabel}
            </button>
          )}
        </div>
      </header>

      {/* Stepper (S1〜S7) */}
      <nav className="setup-stepper-wrap" aria-label="進み具合">
        <div className="setup-stepper">
          {STEP_INFOS.slice(1).map((s, idx) => {
            const stepNum = idx + 1;
            const isActive = currentStep === stepNum;
            const isCompleted = currentStep > stepNum;
            return (
              <div key={s.id} style={{ display: 'flex', alignItems: 'center', flex: idx < 6 ? 1 : 'none' }}>
                <button
                  type="button"
                  className={`step-item ${isActive ? 'active' : ''} ${isCompleted ? 'completed' : ''}`}
                  onClick={() => setStep(stepNum)}
                  title={`${s.id} ${s.title}`}
                >
                  <div className="step-circle">
                    {isCompleted ? '✓' : stepNum}
                  </div>
                  <span className="step-label">{s.shortTitle}</span>
                </button>
                {idx < 6 && (
                  <div className={`step-line ${isCompleted ? 'completed' : ''}`} />
                )}
              </div>
            );
          })}
        </div>
      </nav>

      {/* Main card */}
      <main className={`setup-main ${currentStep === 2 || currentStep === 4 || currentStep === 6 || currentStep === 7 ? 'wide' : ''}`}>
        <section className="setup-card">
          {currentStep === 0 && (
            <Step0Intro onStart={() => setStep(1)} />
          )}

          {currentStep === 1 && (
            <Step1Facility
              data={state.facility}
              onChange={(facility) => updateState((prev) => updateFacility(prev, facility))}
            />
          )}

          {currentStep === 2 && (
            <Step2Shifts
              data={state.shifts}
              onChange={(shifts) => updateState((prev) => updateShifts(prev, shifts))}
              onRenameId={(oldId, newId) => updateState((prev) => renameShiftId(prev, oldId, newId))}
              onApplyPreset={(preset) => updateState((prev) => applyShiftPreset(prev, preset))}
            />
          )}

          {currentStep === 3 && (
            <Step3Need
              data={state.needPerShift}
              useWeekdayNeed={Boolean(state.useWeekdayNeed)}
              needByWeekday={state.needByWeekday ?? {}}
              shifts={state.shifts}
              unitCount={state.facility.units.length}
              onChange={(needPerShift) => updateState((prev) => updateNeedPerShift(prev, needPerShift))}
              onChangeWeekday={(useWeekdayNeed, needByWeekday) =>
                updateState((prev) => updateWeekdayNeed(prev, useWeekdayNeed, needByWeekday))
              }
              onAlignAllToUnits={(target) => updateState((prev) => alignAllNeedToUnits(prev, target))}
            />
          )}

          {currentStep === 4 && (
            <Step4Staff
              data={state.staff}
              facility={state.facility}
              shifts={state.shifts}
              onChange={(staff) => updateState((prev) => ({ ...prev, staff }))}
            />
          )}

          {currentStep === 5 && (
            <Step5Rules
              data={state.rules}
              onChange={(rules) => updateState((prev) => updateRules(prev, rules))}
              onJumpStep={setStep}
            />
          )}

          {currentStep === 6 && (
            <Step6CarryIn
              data={state.carryIn}
              history={state.history ?? {}}
              staff={state.staff}
              shifts={state.shifts}
              onChange={(carryIn, history) =>
                updateState((prev) => ({ ...prev, carryIn, history }))
              }
            />
          )}

          {currentStep === 7 && (
            <Step7Verify state={state} onJumpStep={setStep} />
          )}
        </section>
      </main>

      {/* Footer navigation */}
      <footer className="setup-footer">
        <div className="setup-footer-inner">
          {currentStep > 0 ? (
            <button
              type="button"
              className="btn btn-danger-text"
              onClick={handleReset}
            >
              最初からやり直す
            </button>
          ) : (
            <span />
          )}

          <div className="setup-actions-right">
            {currentStep > 0 && (
              <button
                type="button"
                className="btn btn-outline"
                onClick={handleBack}
              >
                戻る
              </button>
            )}

            {currentStep > 0 && currentStep < 7 && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleNext}
              >
                次へ進む
              </button>
            )}

            {currentStep === 7 && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleFinishToLeader}
              >
                リーダー画面へ
              </button>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}
