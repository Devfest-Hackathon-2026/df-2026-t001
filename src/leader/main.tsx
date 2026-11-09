import { render } from 'preact';
import '../shared/base.css';
import './leader.css';
import { App } from './App';
import { installAiBridge } from '../core/aibridge';
import { warmRanker } from '../core/apirank';
installAiBridge();
warmRanker(); // 打診の順番を並べる API（Cloud Run）を先に起こしておく。失敗しても何もしない
render(<App />, document.getElementById('app')!);
