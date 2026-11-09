import { render } from 'preact';
import '../shared/base.css';
import './employee.css';
import { App } from './App';
import { installAiBridge } from '../core/aibridge';
import { warmUpSolver } from '../core/aiintent';
installAiBridge();
warmUpSolver();
render(<App />, document.getElementById('app')!);
