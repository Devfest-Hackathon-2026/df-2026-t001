import { DEFAULT_SETUP_STATE, normalizeShiftItem } from './defaults';
import { SetupState } from './types';

/** はじめの条件の保存先。リーダー画面も、これが無いことで「初めて開いた」と判断する */
export const STORAGE_KEY = 'care-setup-v2';

export function loadSavedSetupState(): SetupState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    const merged: SetupState = {
      ...DEFAULT_SETUP_STATE,
      ...parsed,
    };
    if (Array.isArray(parsed?.shifts)) {
      merged.shifts = parsed.shifts.map(normalizeShiftItem);
    }
    return merged;
  } catch (e) {
    console.error('Failed to load setup state from localStorage', e);
    return null;
  }
}

export function loadSetupState(): SetupState {
  return loadSavedSetupState() ?? JSON.parse(JSON.stringify(DEFAULT_SETUP_STATE));
}

export function saveSetupState(state: SetupState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error('Failed to save setup state to localStorage', e);
  }
}

export function resetSetupState(): SetupState {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    console.error('Failed to reset setup state in localStorage', e);
  }
  const fresh = JSON.parse(JSON.stringify(DEFAULT_SETUP_STATE));
  saveSetupState(fresh);
  return fresh;
}
