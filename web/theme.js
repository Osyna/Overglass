'use strict';
// Runs in <head> before first paint so a saved choice never flashes the wrong theme.
// Absent choice = follow the device (prefers-color-scheme in tokens.css).
const THEME_KEY = 'webos-foundry-theme';

function savedTheme() {
  try { const v = localStorage.getItem(THEME_KEY); return v === 'light' || v === 'dark' ? v : ''; } catch { return ''; }
}

function applyTheme(choice) {
  if (choice) document.documentElement.dataset.theme = choice; else delete document.documentElement.dataset.theme;
  try { if (choice) localStorage.setItem(THEME_KEY, choice); else localStorage.removeItem(THEME_KEY); } catch { /* storage blocked: the choice lasts until reload */ }
}

function effectiveTheme() {
  return document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

if (savedTheme()) document.documentElement.dataset.theme = savedTheme();
