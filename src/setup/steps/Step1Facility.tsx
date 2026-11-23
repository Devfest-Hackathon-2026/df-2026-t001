import { FacilitySetup, UnitItem } from '../types';
import { DEFAULT_SETUP_STATE } from '../defaults';
import { SETUP_USAGE, usageChipLabel } from '../usage';

const DEFAULT_FACILITY = DEFAULT_SETUP_STATE.facility;

const FACILITY_KINDS = [
  '特別養護老人ホーム',
  '介護老人保健施設',
  'グループホーム',
  '有料老人ホーム',
  'サービス付き高齢者向け住宅',
  'デイサービス',
  'その他',
];

export function Step1Facility({
  data,
  onChange,
}: {
  data: FacilitySetup;
  onChange: (data: FacilitySetup) => void;
}) {
  const handleNameChange = (value: string) => {
    onChange({ ...data, name: value });
  };

  const handleKindChange = (value: string) => {
    onChange({ ...data, kind: value });
  };

  const handleUnitChange = (index: number, patch: Partial<UnitItem>) => {
    const nextUnits = data.units.map((u, idx) =>
      idx === index ? { ...u, ...patch } : u
    );
    onChange({ ...data, units: nextUnits });
  };

  const handleAddUnit = () => {
    const nextNum = data.units.length + 1;
    const nextFloor = data.units.length > 0
      ? data.units[data.units.length - 1].floor
      : 1;
    const newUnit: UnitItem = {
      id: `u${Date.now()}`,
      name: `${nextNum}番ユニット`,
      floor: nextFloor,
    };
    onChange({ ...data, units: [...data.units, newUnit] });
  };

  const handleRemoveUnit = (index: number) => {
    const nextUnits = data.units.filter((_, idx) => idx !== index);
    onChange({ ...data, units: nextUnits });
  };

  const hasPlaceholder =
    data.name === DEFAULT_FACILITY.name ||
    data.units.some((u) => DEFAULT_FACILITY.units.some((d) => d.name === u.name));

  return (
    <div>
      <h2>施設とユニットを教えてください</h2>
      <p className="setup-description">
        施設の基本情報と、職員が所属するユニット（階やフロア）を入力します。途中で分からなければ、あとからでも直せます。
      </p>

      {hasPlaceholder && (
        <div className="notice-box">
          <strong>仮の値が入っています</strong> — 施設名やユニット名を実際の名称に書き換えてお使いください。
        </div>
      )}

      <div className="form-section">
        <div className="form-group">
          <div className="form-label-row">
            <label className="form-label" htmlFor="facility-name">
              施設名
            </label>
            {!SETUP_USAGE.facilityName && (
              <span className="chip-muted">{usageChipLabel(false)}</span>
            )}
          </div>
          <input
            id="facility-name"
            type="text"
            className="form-input"
            value={data.name}
            placeholder="例：ひだまりの郷"
            onInput={(e) => handleNameChange((e.target as HTMLInputElement).value)}
          />
          <p className="form-hint">
            {SETUP_USAGE.facilityName
              ? '画面の表示にだけ使います。シフトを作る計算には送信しません。空のままでも先に進めます。'
              : 'リーダー画面につないだあとは、画面の表示にだけ使います（シフトを作る計算には送信しません）。いまはまだ使っていません。空のままでも先に進めます。'}
          </p>
        </div>

        <div className="form-group">
          <div className="form-label-row">
            <label className="form-label" htmlFor="facility-kind">
              施設の種類
            </label>
            {!SETUP_USAGE.facilityKind && (
              <span className="chip-muted">{usageChipLabel(false)}</span>
            )}
          </div>
          <select
            id="facility-kind"
            className="form-select"
            value={data.kind}
            onChange={(e) => handleKindChange((e.target as HTMLSelectElement).value)}
          >
            {FACILITY_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
          <p className="form-hint">
            将来のルール提案に向けたメモとして保存します。いまのシフト作成の計算には使いません。
          </p>
        </div>
      </div>

      <div className="form-section">
        <div className="form-label-row" style={{ marginBottom: '8px' }}>
          <span className="form-label">ユニット（フロア・グループ）</span>
          {!SETUP_USAGE.units && (
            <span className="chip-muted">{usageChipLabel(false)}</span>
          )}
        </div>
        <p className="form-hint" style={{ marginBottom: '16px' }}>
          {SETUP_USAGE.units
            ? 'このあと登録する職員の「所属ユニット」の選択肢になります。ユニット分けがない施設は0件のままでも進められます（あとで足せます）。'
            : 'このあと登録する職員の「所属ユニット」の選択肢になります。いまはまだリーダー画面・シフト作成には使っていません。ユニット分けがない施設は0件のままでも進められます（あとで足せます）。'}
        </p>

        {data.units.length === 0 ? (
          <div className="empty-inline">
            ユニットはまだ登録されていません。このまま先に進むか、下のボタンから追加してください（あとで足せます）。
          </div>
        ) : (
          <div className="unit-list">
            {data.units.map((unit, idx) => (
              <div key={unit.id} className="unit-row">
                <div className="unit-field">
                  <label className="unit-field-label" htmlFor={`unit-name-${unit.id}`}>
                    ユニット名
                  </label>
                  <input
                    id={`unit-name-${unit.id}`}
                    type="text"
                    className="form-input"
                    value={unit.name}
                    placeholder="例：ひなた"
                    maxLength={20}
                    onInput={(e) =>
                      handleUnitChange(idx, { name: (e.target as HTMLInputElement).value })
                    }
                  />
                </div>
                <div className="unit-field">
                  <label className="unit-field-label" htmlFor={`unit-floor-${unit.id}`}>
                    階
                  </label>
                  <div className="unit-floor-wrap">
                    <input
                      id={`unit-floor-${unit.id}`}
                      type="number"
                      min={1}
                      max={20}
                      className="form-input"
                      value={unit.floor}
                      onInput={(e) => {
                        const n = parseInt((e.target as HTMLInputElement).value, 10);
                        handleUnitChange(idx, { floor: Number.isNaN(n) ? 1 : Math.max(1, Math.min(20, n)) });
                      }}
                    />
                    <span className="unit-floor-suffix">階</span>
                  </div>
                </div>
                <button
                  type="button"
                  className="btn-icon-remove"
                  onClick={() => handleRemoveUnit(idx)}
                  aria-label={`${unit.name || 'ユニット'}を削除`}
                >
                  削除
                </button>
              </div>
            ))}
          </div>
        )}

        <button
          type="button"
          className="btn btn-outline btn-sm"
          onClick={handleAddUnit}
        >
          ＋ ユニットを足す
        </button>
      </div>
    </div>
  );
}
