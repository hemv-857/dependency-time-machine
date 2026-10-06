/**
 * Copy text to the clipboard, resolving to whether it can be trusted.
 *
 * `navigator.clipboard?.writeText()` is not enough on its own: `?.` only guards
 * a missing clipboard, not the promise rejecting. It rejects whenever clipboard
 * permission is denied, so an unguarded call throws an unhandled rejection and
 * the UI still reports success.
 *
 * The async clipboard is the only trustworthy signal. `document.execCommand`
 * is deprecated and returns true even when it copies nothing, so it is used
 * only when the async clipboard does not exist at all (old browser, or a
 * non-secure origin where `navigator.clipboard` is undefined) — never to
 * override an explicit permission denial.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}