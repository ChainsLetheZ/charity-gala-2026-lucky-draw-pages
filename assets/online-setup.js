export async function configureOnlineSync(currentToken) {
  const settings = document.createElement('button');
  settings.type = 'button';
  settings.textContent = '同步设置';
  settings.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:40;border:1px solid #ccc;border-radius:8px;padding:10px 16px;background:white;color:#222;cursor:pointer';
  document.body.append(settings);
  let pendingResolve;
  function openSetup() {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:1000;display:grid;place-items:center;background:#0009;padding:24px';
    overlay.innerHTML = `<form style="width:min(400px,90vw);padding:28px;background:white;border-radius:14px;color:#222;font:16px/1.6 sans-serif"><h1 style="font-size:24px;margin-top:0">连接晚会抽奖</h1><p>输入现有同步口令，连接会场大屏。</p><label for="onlineSyncToken">同步口令</label><input id="onlineSyncToken" name="token" type="password" required autocomplete="off" style="display:block;box-sizing:border-box;width:100%;padding:12px;margin:8px 0 20px;font:inherit"><button type="submit" style="width:100%;padding:12px;border:0;border-radius:6px;background:#c91832;color:white;font:inherit;cursor:pointer">连接</button></form>`;
    const form = overlay.querySelector('form');
    const input = overlay.querySelector('input');
    // Do not let game shortcuts react to text entered in the settings form.
    for (const event of ['keydown', 'keyup']) overlay.addEventListener(event, e => e.stopPropagation());
    form.addEventListener('submit', event => {
      event.preventDefault();
      const token = input.value.trim();
      if (!token) return;
      sessionStorage.setItem('gala-sync-token', token);
      overlay.remove();
      if (pendingResolve) { pendingResolve(token); pendingResolve = null; }
      else {
        const clean = new URL(location.href);
        clean.searchParams.delete('token');
        const hash = new URLSearchParams(clean.hash.slice(1));
        hash.delete('token');
        clean.hash = hash.toString();
        history.replaceState(null, '', clean);
        location.reload();
      }
    });
    document.body.append(overlay);
    input.focus();
  }
  settings.addEventListener('click', openSetup);
  if (currentToken) return currentToken;
  return new Promise(resolve => { pendingResolve = resolve; openSetup(); });
}
