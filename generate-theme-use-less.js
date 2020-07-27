const hash = require('hash.js');
const fs = require('fs');
const path = require('path');

const htmlFileRegExp = /\.html$/;
const lessThemeStyleId = 'lessThemeStyleId';
const lessJsPath = 'js/less.min.js';
const {
  getShade,
  minifyCss,
  hmrJsFileRegExp,
  isDev,
} = require('./utils');

// 判断是否更新
let cacheHashCode = null;

/**
 *
 * @description 将less文件插入到html中
 */
function insertLessFileInHtml({
  compilation,
  cssContent,
  themeVars,
}) {
  const { assets } = compilation;
  if (!assets[lessJsPath]) {
    const content = fs.readFileSync(path.resolve(__dirname, './less.min.js'));
    assets[lessJsPath] = {
      source: () => content,
      size: () => content.length,
    }
  }
  const htmls = Object.keys(assets).filter((k) => htmlFileRegExp.test(k));
  htmls.forEach((fileName) => {
    const htmlContent = assets[fileName]
      .source()
      .toString()
      .replace(
        '</head>',
        `<style type="text/less" id="${lessThemeStyleId}">${cssContent}</style>
        <script>
          less = {
            env: ${isDev ? '"development"' : '"production"'},
            logLevel: 2,
            async: false,
            globalVars: JSON.parse(localStorage.getItem('theme_color')) || ${JSON.stringify(themeVars)}
          };
          (function(){
            var style = document.querySelector('#${lessThemeStyleId}');
            window.__lessContent = style.innerHTML;
            window.changeThemeUseLess = function(vars) {
              style.type = 'text/less';
              style.innerHTML = window.__lessContent;
              window.less.refreshStyles(vars);
              localStorage.setItem('theme_color', JSON.stringify(vars));
            }
          })();
        </script>
        <script src="${lessJsPath}"></script></head>`,
      );
    assets[fileName].source = () => htmlContent;
    assets[fileName].size = () => htmlContent.length;
  });
}

/**
* @description 使用less生成主题
*/
module.exports = function generateThemeUseLess({
 compilation,
 // fileName,
 cssContent,
 mappings,
 themeCompiledVars,
}) {
 const themeVars = {};
 Object.keys(themeCompiledVars).forEach((varName) => {
   let color;
   if (/(.*)-(\d)/.test(varName)) {
     color = themeCompiledVars[varName];
     varName = getShade(varName);
   } else {
     themeVars[varName] = mappings[varName];
     color = themeCompiledVars[varName];
   }
   color = color.replace('(', '\\(').replace(')', '\\)');
   cssContent = cssContent.replace(new RegExp(color, 'g'), varName);
 });
 cssContent = minifyCss(cssContent);
 // 计算hash值
 const hashCode = hash.sha256().update(cssContent).digest('hex');
 // // 生成具体的文件名
 // const filePath = compilation.getPath(fileName, { contentHash: hashCode });
 // compilation.assets[filePath] = {
 //   source: () => cssContent,
 //   size: () => cssContent.length,
 // };
 insertLessFileInHtml({
   compilation,
   cssContent,
   themeVars,
 });

 if (cacheHashCode && cacheHashCode !== hashCode) {
   const { assets } = compilation;
   const firstHmrJsName = Object.keys(assets).find((k) => hmrJsFileRegExp.test(k));
   if (firstHmrJsName) {
     const firstHmrJs = assets[firstHmrJsName];
     const originalContent = firstHmrJs.source();
     // TODO：需要热更新样式
     const content = `
     ;(function() {
       window.__lessContent = '${cssContent}';
       window.changeThemeUseLess(JSON.parse(localStorage.getItem('theme_color')) || ${JSON.stringify(themeVars)});
     })();
     \n
     ${originalContent}`;
     firstHmrJs.source = () => content;
     firstHmrJs.size = () => content.length;
   }
 }

 cacheHashCode = hashCode;
}
