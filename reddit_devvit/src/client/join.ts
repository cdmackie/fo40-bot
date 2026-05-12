import { navigateTo, showToast } from '@devvit/web/client';
import type { JoinTokenResponse } from '../shared/api';

const button = document.getElementById('join-button') as HTMLButtonElement;
const errorEl = document.getElementById('error') as HTMLParagraphElement;

function setError(msg: string): void {
  errorEl.textContent = msg;
  errorEl.hidden = false;
}

function clearError(): void {
  errorEl.textContent = '';
  errorEl.hidden = true;
}

async function handleClick(): Promise<void> {
  clearError();
  button.disabled = true;
  button.textContent = 'Generating invite...';

  try {
    const res = await fetch('/api/join-token', { method: 'POST' });
    const data = (await res.json()) as JoinTokenResponse;

    if (data.ok) {
      navigateTo(data.url);
      return;
    }

    if (data.reason === 'not_configured') {
      setError("This community's Discord link isn't fully set up yet. Tell a mod.");
    } else if (data.reason === 'not_logged_in') {
      setError("Couldn't read your Reddit username. Are you logged in?");
    } else {
      setError("Couldn't create your invite right now. Try again in a moment.");
    }
  } catch (err) {
    console.error('[fo40-bridge] join-token request failed:', err);
    showToast("Couldn't create your invite right now. Try again in a moment.");
  } finally {
    button.disabled = false;
    button.textContent = 'Get Discord invite';
  }
}

button.addEventListener('click', () => {
  void handleClick();
});
