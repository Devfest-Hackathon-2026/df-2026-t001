#!/usr/bin/env python3
"""docs/architecture.svg を生成する。Google Cloud 公式アイコン（docs/icons/、無加工）を data URI で埋め込む。

  python3 docs/make_architecture_svg.py
GitHub の README は <img> でSVGを表示し、外部ファイルの参照が効かないため、アイコンは埋め込む。
"""
import base64
import html
from pathlib import Path

D = Path(__file__).parent
ic = {k: base64.b64encode((D / f'icons/{k}.svg').read_bytes()).decode() for k in ('CloudRun', 'BigQuery', 'CloudStorage', 'VertexAI')}
W, H = 1280, 880
o = []


def box(x, y, w, h, title, lines=(), icon=None, fill='#ffffff', stroke='#dadce0', tc='#202124', dash=False):
    d = ' stroke-dasharray="6 4"' if dash else ''
    o.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="{fill}" stroke="{stroke}" stroke-width="1.5"{d}/>')
    tx = x + 16
    if icon:
        o.append(f'<image x="{x + 12}" y="{y + 12}" width="44" height="44" href="data:image/svg+xml;base64,{ic[icon]}"/>')
        tx = x + 66
    o.append(f'<text x="{tx}" y="{y + 34}" font-size="17" font-weight="600" fill="{tc}">{html.escape(title)}</text>')
    for i, l in enumerate(lines):
        o.append(f'<text x="{tx if icon else x + 16}" y="{y + 58 + i * 20}" font-size="13" fill="#5f6368">{html.escape(l)}</text>')


def path(pts, label=None, lx=None, ly=None, dash=False, color='#1a73e8', anchor='middle'):
    d = ' stroke-dasharray="7 5"' if dash else ''
    p = 'M' + ' L'.join(f'{x} {y}' for x, y in pts)
    o.append(f'<path d="{p}" fill="none" stroke="{color}" stroke-width="2"{d} marker-end="url(#a{"g" if color == "#34a853" else "b" if color == "#5f6368" else ""})"/>')
    if label:
        o.append(f'<text x="{lx}" y="{ly}" font-size="12" fill="#3c4043" text-anchor="{anchor}">{html.escape(label)}</text>')


o.append(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" font-family="Noto Sans JP, Hiragino Sans, Meiryo, system-ui, sans-serif">')
o.append('<defs>' + ''.join(
    f'<marker id="a{s}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0L10 5L0 10z" fill="{c}"/></marker>'
    for s, c in (('', '#1a73e8'), ('g', '#34a853'), ('b', '#5f6368'))) + '</defs>')
o.append(f'<rect width="{W}" height="{H}" fill="#f8f9fa"/>')
o.append('<text x="40" y="44" font-size="24" font-weight="700" fill="#202124">助っ人ケア（介護施設の夜勤欠員対応）— アーキテクチャ</text>')
o.append('<text x="40" y="68" font-size="13" fill="#5f6368">Google Cloud: asia-northeast1（Gemini は global エンドポイント）。データはすべて架空。</text>')
o.append('<rect x="24" y="90" width="1232" height="480" rx="16" fill="#ffffff" stroke="#e8eaed"/><text x="44" y="116" font-size="13" font-weight="600" fill="#1a73e8">リアルタイム（利用時）</text>')
o.append('<rect x="24" y="590" width="1232" height="250" rx="16" fill="#ffffff" stroke="#e8eaed"/><text x="44" y="616" font-size="13" font-weight="600" fill="#34a853">学習（週次・Vertex AI Pipelines）</text>')
# 利用側
box(48, 300, 180, 96, 'リーダー・従業員', ['ブラウザ / スマホ', 'Preact + Vite UI'])
box(268, 300, 190, 96, 'Firebase Hosting', ['UI 配信・CSP', '/api/** → care-api'])
box(520, 140, 230, 96, 'care-api', ['画面状態の同期', 'Firestore: state'], icon='CloudRun')
box(520, 270, 380, 270, 'care-solver-api',
    ['4 vCPU・2GiB・公開（IP 制限）', '', 'CP-SAT：月次＋日次（集約制約で連携）', '欠員フロー・最小変更の組み直し', '応諾確率で候補を順位付け（学習済みモデル）',
     'AI：ルール翻訳・説明・チャット（読み取り＋提案）', '反復検出の候補・ルール管理'], icon='CloudRun', stroke='#1a73e8')
box(960, 130, 270, 92, 'Gemini（Vertex AI）', ['Pro: 翻訳 / Flash: 説明・チャット', 'ADC（API キー無し）'])
box(960, 240, 270, 76, 'Sensitive Data Protection', ['入力の個人情報を伏せ字'])
box(960, 336, 270, 92, 'Firestore', ['施設・従業員・提案（不変）', '編集ログ（追記）・欠員・ルール'])
box(960, 448, 270, 92, 'Pub/Sub', ['業務イベント（打診・応答…）', '→ BigQuery subscription'])
# 学習側
box(48, 650, 300, 150, 'Vertex AI Pipelines',
    ['extract → train → promote', '施設ごとに3種類のモデルを', '交差検証で比べ、基準に勝てた', 'ものだけ昇格・Registry に登録', '手修正のくり返しの検出も実行'], icon='VertexAI')
box(440, 650, 280, 150, 'BigQuery', ['履歴・特徴量・予測（out-of-fold）', '学習の記録（model_runs）', 'チャットの集計（読み取り専用）'], icon='BigQuery')
box(800, 650, 300, 150, 'Cloud Storage', ['models/<施設>/champion.json', 'learned/<施設>.json（ルール候補）', '実行の中間成果物（30日で削除）'], icon='CloudStorage')
box(1130, 650, 110, 150, 'Looker', ['見送り'], dash=True, fill='#f8f9fa', stroke='#bdc1c6', tc='#80868b')
# 矢印（箱を横切らない経路）
path([(228, 348), (268, 348)])
path([(458, 330), (490, 330), (490, 188), (520, 188)], '/api/**', 470, 214, anchor='end')
path([(458, 370), (520, 370)], '画面から直接（CORS）', 400, 420, dash=True)
path([(900, 300), (930, 300), (930, 176), (960, 176)], '翻訳・説明・チャット', 925, 150, anchor='end')
path([(900, 340), (930, 340), (930, 278), (960, 278)])
path([(900, 400), (960, 382)])
path([(900, 480), (930, 480), (930, 494), (960, 494)], 'イベント', 925, 470, anchor='end')
path([(1095, 540), (1095, 570), (580, 570), (580, 650)], 'BigQuery subscription', 840, 562, color='#5f6368')
path([(348, 725), (440, 725)], '読み取り', 394, 717)
path([(200, 800), (200, 826), (950, 826), (950, 800)], 'champion・候補を書き込み', 575, 818)
path([(880, 650), (880, 540)], '成果物を読み込み（採点）', 892, 600, dash=True, color='#34a853', anchor='start')
o.append('<text x="40" y="866" font-size="12" fill="#80868b">アイコン: Google Cloud 公式（cloud.google.com/icons。Cloud Run・BigQuery・Cloud Storage・Vertex AI は無加工）。そのほかのサービスは文字のみ。</text>')
o.append('</svg>')
(D / 'architecture.svg').write_text('\n'.join(o), encoding='utf-8')
print(f'{len(chr(10).join(o)) // 1024} KB')
