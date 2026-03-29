/**
 * Global Toast Notification System
 * Usage: showToast('Message', 'success' | 'error' | 'warning' | 'info', durationMs)
 */
(function () {
  const colors = { success: '#22c55e', error: '#ef4444', warning: '#f59e0b', info: '#4f8ef7' };
  const icons  = { success: '✓',      error: '✗',      warning: '⚠',      info: 'ℹ'      };

  // Inject keyframe animations once
  if (!document.getElementById('toast-anim-style')) {
    const style = document.createElement('style');
    style.id = 'toast-anim-style';
    style.textContent = `
      @keyframes toastSlideIn  { from { transform: translateX(110%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
      @keyframes toastSlideOut { from { transform: translateX(0);    opacity: 1; } to { transform: translateX(110%); opacity: 0; } }
      #toast-container { position: fixed; bottom: 24px; right: 24px; z-index: 9999; display: flex; flex-direction: column; gap: 10px; pointer-events: none; }
      .toast-item { pointer-events: auto; }
    `;
    document.head.appendChild(style);
  }

  // Shared container so toasts stack neatly
  function getContainer() {
    let c = document.getElementById('toast-container');
    if (!c) {
      c = document.createElement('div');
      c.id = 'toast-container';
      document.body.appendChild(c);
    }
    return c;
  }

  function showToast(message, type = 'info', duration = 3000) {
    const color = colors[type] || colors.info;
    const icon  = icons[type]  || icons.info;

    const toast = document.createElement('div');
    toast.className = 'toast-item';
    toast.style.cssText = `
      background: #1e2432;
      border-left: 4px solid ${color};
      color: #f1f5f9;
      padding: 14px 20px;
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.35);
      font-size: 14px;
      font-family: inherit;
      display: flex;
      align-items: center;
      gap: 10px;
      max-width: 360px;
      animation: toastSlideIn 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards;
      line-height: 1.4;
    `;
    toast.innerHTML = `<span style="color:${color};font-weight:bold;font-size:16px;flex-shrink:0;">${icon}</span><span>${message}</span>`;
    getContainer().appendChild(toast);

    setTimeout(() => {
      toast.style.animation = 'toastSlideOut 0.3s ease forwards';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  window.showToast = showToast;
})();
