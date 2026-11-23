import { render } from 'preact';
import { App } from './App';
import './setup.css';
import './steps.css';

const root = document.getElementById('app');
if (root) {
  render(<App />, root);
}
