// 主题：默认浅色，可切换深色（记在本机）；放在 <head> 里尽早执行，避免闪烁
(function () {
  try { var t = localStorage.getItem("hzz-theme"); if (t === "dark" || t === "light") document.documentElement.dataset.theme = t; } catch (e) {}
})();
