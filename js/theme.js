/**
 * Light / dark theme toggle.
 * Reads from localStorage on load, writes back on toggle.
 * The <html data-theme="..."> attribute drives all CSS variables.
 */

const THEME_KEY = 'arxiv-forum-theme';

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY) || 'dark';
  applyTheme(saved, false);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark', true);
}

function applyTheme(theme, animate) {
  const root = document.documentElement;

  if (animate) {
    // Brief fade so the switch doesn't feel jarring
    root.style.transition = 'background .25s, color .25s';
    setTimeout(() => root.style.transition = '', 300);
  }

  root.setAttribute('data-theme', theme);
  localStorage.setItem(THEME_KEY, theme);

  const btn = document.getElementById('themeToggle');
  if (btn) btn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  updateIcon(theme);
}

function updateIcon(theme) {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  // Sun icon for dark mode (click to go light), moon icon for light mode (click to go dark)
  btn.innerHTML = theme === 'dark' ? sunIcon() : moonIcon();
}

function sunIcon() {
  return `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="5"/>
    <line x1="12" y1="1"  x2="12" y2="3"/>
    <line x1="12" y1="21" x2="12" y2="23"/>
    <line x1="4.22" y1="4.22"  x2="5.64" y2="5.64"/>
    <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
    <line x1="1" y1="12" x2="3" y2="12"/>
    <line x1="21" y1="12" x2="23" y2="12"/>
    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
    <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
  </svg>`;
}

function moonIcon() {
  return `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
  </svg>`;
}

window.toggleTheme = toggleTheme;
window.initTheme   = initTheme;
