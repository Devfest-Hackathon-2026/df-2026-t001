import { render } from 'preact';
import '../shared/base.css';
import './employee.css';
import { App } from './App';
import { installAiBridge } from '../core/aibridge';
installAiBridge();
render(<App />, document.getElementById('app')!);
