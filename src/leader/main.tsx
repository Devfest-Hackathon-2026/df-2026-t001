import { render } from 'preact';
import '../shared/base.css';
import './leader.css';
import { App } from './App';
import { installAiBridge } from '../core/aibridge';
import { warmRanker } from '../core/apirank';
import { STORAGE_KEY as SETUP_KEY } from '../setup/storage';

// 初めて開いたら（はじめの条件がまだ保存されていなければ）、先に条件入力へ送る。
// ?demo を付けて開くと送らない（架空データのデモをそのまま見る・確認スクリプト用）。
function needsSetup(): boolean {
  try { return localStorage.getItem(SETUP_KEY) === null && !new URLSearchParams(location.search).has('demo'); } catch { return false; }
}
if (needsSetup()) {
  location.replace('./setup.html');
} else {
  installAiBridge();
  warmRanker(); // 打診の順番を並べる API（Cloud Run）を先に起こしておく。失敗しても何もしない
  render(<App />, document.getElementById('app')!);
}
