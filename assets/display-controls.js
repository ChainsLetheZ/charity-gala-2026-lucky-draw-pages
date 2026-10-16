const button = document.createElement('button');
button.type = 'button';
button.textContent = '全屏';
button.setAttribute('aria-label', '全屏展示');
button.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:12;padding:9px 14px;border:1px solid #777;border-radius:999px;background:#fff;color:#222;font:14px Arial,sans-serif;opacity:.16;cursor:pointer';
button.addEventListener('mouseenter', () => button.style.opacity = '1');
button.addEventListener('mouseleave', () => button.style.opacity = '.16');
button.addEventListener('click', () => {
  const action = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
  action.catch(() => {});
});
document.body.append(button);
