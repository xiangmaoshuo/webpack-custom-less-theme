const hash = require('hash.js');
const fs = require('fs');
const path = require('path');
const UglifyJS = require('uglify-es');

const lessThemeStyleId = 'lessThemeStyleId';
const {
  DERIVED_COLOR_TAG,
  THEME_COMPILED_CSS_REGEXP,
  LOCAL_STORAGE_COLOR_NAME,
} = require('./constant');
const {
  getShade,
  minifyCss,
  hmrJsFileRegExp,
  getMatches,
  isDev,
  IsPathExist,
} = require('./utils');

// 开发环境下给less加一个后缀，避免同项目中的文件路径重复
const mockHash = Date.now();

// 判断是否更新
let cacheHashCode = null;
let cacheLessJsContent = null;

/**
 * @description 生成带有hash的文件
 */
function insertFileWithHash(compilation, content, fileName) {
  const hashCode = hash.sha256().update(content).digest('hex');
  // 生成具体的文件名
  const filePath = compilation.getPath(fileName, { contentHash: hashCode });
  compilation.assets[filePath] = {
    source: () => content,
    size: () => content.length,
  };
  return filePath;
}

/**
 * @description 读取less.js/less.min.js
 */
function loadLessJs(isProEnv) {
  if (!cacheLessJsContent) {
    cacheLessJsContent = fs.readFileSync(path.resolve(__dirname, `./less${isProEnv && '.min'}.js`));
  }
  return cacheLessJsContent;
}

/**
 * @description 生成less.js内容
 */
function generateLessContent(themeVars) {
  const isDevEnv = isDev() ? true : '';
  const isProEnv = !isDevEnv ? true : '';
  return `
    (function(w){
      var storageName = ${LOCAL_STORAGE_COLOR_NAME};
      var regExp = ${THEME_COMPILED_CSS_REGEXP};
      ${isDevEnv && `var style = document.getElementById('${lessThemeStyleId}');`}
      function getVars(vars) {
        var original = ${JSON.stringify(themeVars)};
        for ( k in vars) {
          vars[k]&&(original[k] = vars[k]);
        }
        return original;
      }
      w.less = {
        env: '${isDevEnv ? 'development' : 'production'}',
        logLevel: 2,
        async: false,
        ${isDevEnv && 'errorReporting: \'console\','}
        javascriptEnabled: true,
        globalVars: getVars(JSON.parse(localStorage.getItem(storageName)) || {})
      };
      ${isDevEnv && 'w.__lessContent = style.innerHTML;'}
      ${loadLessJs(isProEnv)}
      ${getMatches}
      function gt(){
        w.less.themeColors=getMatches(
          ${isDevEnv ? 'style' : `document.getElementById('less:${lessThemeStyleId}')`}.innerHTML,
          regExp
        );
      }
      ${isDevEnv ? 'gt();' : 'w.less.pageLoadFinished.then(gt);'}
      w.less.changeTheme = function(vars${isDevEnv && ', isHmr = false'}) {
        var target = getVars(vars);
        ${
          isDevEnv
          ? `
          style.type = 'text/less';
          style.innerHTML = w.__lessContent;
          w.less.refreshStyles(target);
          gt();
          if (!isHmr) {
            localStorage.setItem(storageName, JSON.stringify(target));
          }`
          : `
          w.less.modifyVars(target).then(function(){
            gt();
            localStorage.setItem(storageName, JSON.stringify(target));
          });`
        }
      }
    })(window);
  `;
}

/**
 *
 * @description 将less文件插入到html中
 */
function insertLessFileInHtml({
  compilation,
  cssContent,
  themeVars,
  options,
}) {
  const { assets, options: { output: { publicPath } } } = compilation;
  const isDevEnv = isDev() ? true : '';
  const isProEnv = !isDevEnv ? true : '';
  const lessJsContent = isDevEnv ? generateLessContent(themeVars) : UglifyJS.minify(generateLessContent(themeVars)).code;
  const lessJsPath = isDevEnv ? `js/less.${mockHash}.js` : insertFileWithHash(compilation, lessJsContent, 'js/less.min.[contenthash:8].js');
  const lessCssPath = isProEnv && insertFileWithHash(compilation, cssContent, 'css/theme.colors.[contenthash:8].less');
  const insertHtmlContent = `
  ${isDevEnv
      ? `<style type="text/less" id="${lessThemeStyleId}">${cssContent}</style>`
      : `<link rel="stylesheet/less" type="text/css" href="${publicPath}${lessCssPath}" title="${lessThemeStyleId}" />`}
      <script src="${publicPath}${lessJsPath}"></script></head>
  `;

  assets[lessJsPath] = {
    source: () => lessJsContent,
    size: () => lessJsContent.length,
  }

  const { filterHtml } = options;
  const htmls = Object.keys(assets).filter(filterHtml);
  htmls.forEach((fileName) => {
    const htmlContent = assets[fileName].source().toString().replace('</head>', insertHtmlContent);
    assets[fileName].source = () => htmlContent;
    assets[fileName].size = () => htmlContent.length;
  });
}

/**
* @description 使用less生成主题
*/
module.exports = function generateThemeUseLess({
  compiler,
  compilation,
  cssContent,
  mappings,
  themeCompiledVars,
  options,
  combineLess,
  themeCompiledCss
}) {
 const themeVars = {};

 const nodeModulesPath = path.resolve(compiler.context, './node_modules');
 const uiDir = path.resolve(nodeModulesPath, `./${options.ui}`);
 const uiStyleDir = path.resolve(uiDir, options.uiStyleDir);
 const colorPaletteContent = combineLess(IsPathExist(path.resolve(uiStyleDir, options.colorPaletteFile)), nodeModulesPath);
 const array = options.themeVariables.concat(options.themeSelfVariables); // 主题变量

 cssContent = `${colorPaletteContent}\n${cssContent}`;

 Object.keys(themeCompiledVars).forEach((varName) => {
   let color = themeCompiledVars[varName];
   if (array.includes(varName)) {
    themeVars[varName] = mappings[varName];
   } else {
     // 这些都是衍生变量
     const randomReg = /(.*)-derived-(\d)/;
     if (randomReg.test(varName)) {
       const [_, name, index] = randomReg.exec(varName);
       varName = options.derivedVars[index].replace(DERIVED_COLOR_TAG, name);
     } else {
       // 默认的衍生变量
      varName = getShade(varName);
     }
   }
   color = color.replace('(', '\\(').replace(')', '\\)');
   cssContent = cssContent.replace(new RegExp(color, 'g'), varName);
 });
 cssContent = minifyCss(`${cssContent}${themeCompiledCss}`);

 // 开发环境下，实现热更新
 if (isDev()) {
  // 计算hash值
  const hashCode = hash.sha256().update(`${cssContent}${JSON.stringify(themeVars)}`).digest('hex');
  if (cacheHashCode && cacheHashCode !== hashCode) {
    const { assets } = compilation;
    const firstHmrJsName = Object.keys(assets).find((k) => hmrJsFileRegExp.test(k));
    if (firstHmrJsName) {
      const firstHmrJs = assets[firstHmrJsName];
      const originalContent = firstHmrJs.source();
      /**
       * 这里是将得到的less内容转成js字符串保存，所以需要对字符串做一些处理
       * 1. 这里的js字符串是用单引号表示的，所以需要将less内容中的'做转义
       * 2. less内容表示最终的内容，所以在转为js字符串的时候需要对反斜杠做转义操作
       */
      const content = `
      ;(function(w) {
        w.__lessContent = '${options.hmrTransformLess(cssContent)}';
        w.less.changeTheme(JSON.parse(localStorage.getItem(${LOCAL_STORAGE_COLOR_NAME})) || ${JSON.stringify(themeVars)}, true);
      })(window);
      \n
      ${originalContent}`;
      firstHmrJs.source = () => content;
      firstHmrJs.size = () => content.length;
    }
  }
  cacheHashCode = hashCode;
 }

 insertLessFileInHtml({
   compilation,
   cssContent,
   themeVars,
   options,
 });
}
