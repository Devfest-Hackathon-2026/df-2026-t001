import { isAnySetupUsed, usageChipLabel } from '../usage';

export function Step0Intro({ onStart }: { onStart: () => void }) {
  const anyUsed = isAnySetupUsed();

  return (
    <div className="setup-step-intro">
      <h2>助っ人ケアへようこそ</h2>
      <p className="setup-description">
        あなたの施設でシフトを作るときの条件を、7つのステップで入力する画面です。
      </p>

      {!anyUsed && (
        <p className="setup-usage-note">
          <span className="chip-muted">{usageChipLabel(false)}</span>
          <span>いまの段階では、入れた条件はまだシフト作成に使われません。</span>
        </p>
      )}

      <div className="notice-box">
        <strong>あらかじめ「仮の値」が入っています</strong><br />
        ゼロから全て入力する必要はありません。ご自身の施設に合わせて直しながら、一つずつ進めてください。
        入力内容は自動的にこのブラウザに保存されるため、いつでも続きから再開できます。
      </div>

      <div style={{ marginBottom: '32px' }}>
        <h3 style={{ fontSize: '16px', fontWeight: 500, margin: '0 0 16px 0', color: '#202124' }}>
          これから設定する7つの内容
        </h3>
        <ol style={{ paddingLeft: '20px', margin: 0, color: '#5F6368', fontSize: '14px', lineHeight: '2' }}>
          <li><strong>施設とユニット</strong> — 施設の種類と、グループ・階などのユニットを決めます</li>
          <li><strong>勤務帯</strong> — 早番・日勤・遅番・夜勤の有無と時刻を設定します</li>
          <li><strong>毎日の必要人数</strong> — 各勤務帯に毎日何人入るかを設定します</li>
          <li><strong>職員の一覧</strong> — 働く職員の名前、役割、入れる勤務帯、入れない曜日などを登録します</li>
          <li><strong>守ること（ルール）</strong> — 夜勤の上限回数など、シフトを作るときに守るルールを確認します</li>
          <li><strong>前月の最終日</strong> — 前月末の勤務（夜勤明けなど）を入力します</li>
          <li><strong>確認</strong> — 入力した条件をまとめて確認します</li>
        </ol>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
        <button type="button" className="btn btn-primary" onClick={onStart}>
          設定をはじめる
        </button>
      </div>
    </div>
  );
}
