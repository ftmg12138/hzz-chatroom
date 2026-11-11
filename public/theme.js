// 界面主题（皮肤）：森林 forest（默认）/ 星夜 night / 奶油萌宠 cream / 西幻酒馆 tavern
// 放在 <head> 里尽早执行，避免闪烁；登录后以账号里保存的主题为准（common.js 同步）
(function () {
  var k = "forest";
  try { var t = localStorage.getItem("hzz-skin"); if (/^(forest|night|cream|tavern)$/.test(t || "")) k = t; else if (localStorage.getItem("hzz-theme") === "dark") k = "night"; } catch (e) {}
  document.documentElement.dataset.skin = k;
})();
