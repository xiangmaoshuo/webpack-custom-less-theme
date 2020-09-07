/* eslint-disable no-param-reassign,no-plusplus,no-underscore-dangle */
const fs = require('fs');
const path = require('path');
const postcss = require('postcss');
const less = require('less');
const NpmImportPlugin = require('less-plugin-npm-import');

const generateThemeUseLess = require('./generate-theme-use-less');
const {
  PLUGIN_NAME,
  COLOR_NAME,
  THEME_FILE,
  DERIVED_COLOR_TAG,
  IVIEW_DERIVED_VARS,
  THEME_COMPILED_CSS_PREFIX,
  THEME_COMPILED_CSS_REGEXP,
  COLORS
} = require('./constant');
const {
  getShade,
  minifyCss,
  hmrJsFileRegExp,
  getMatches,
  isDef,
  isDev,
  IsPathExist,
} = require('./utils');

const dftCustomColorRegexArray = ['color', 'lighten', 'darken', 'saturate', 'desaturate', 'fadein', 'fadeout', 'fade', 'spin', 'mix', 'hsv', 'tint', 'shade', 'greyscale', 'multiply', 'contrast', 'screen', 'overlay']
  .map((name) => new RegExp(`${name}\\(.*\\)`));

const CSS_REGEXP_DEV = /\bn?exports\.push\(\[module\.i, \\?"(.+?\})(?:\\?\\n)?(?:[\\n]*\/\*#\s*sourceMappingURL=.+?\*\/)?\\?", \\?"\\?"(?:\]\)|,\s*\{)/g;
const CSS_REGEXP_UGLY = /\.push\(\[\w+\.i,['"](.+?\})[\\rn]*['"],['"]['"](?:\]\)|,\{)/g;
const cssFileRegExp = /\.css$/;
const jsFileRegExp = /\.js$/;

const cssOrJsDevRegExp = /(?:(?:\.hot-update\.js$)|(css|js)\/((?!(less\.js$)).)+\.\1$)/;
const cssOrJsProRegExp = /^css\/.+\.css$/;
// 用以标记js中的css
const cssSplitTag = '/* <get-css-from-asset-comment> */';

// 简单的匹配颜色的正则表达式
const matchColorRegExp = /(?<=(?:^| ))(#[a-fA-F\d]{3,6}|rgb(?:a)?\([\d, ]+\)|transparent|currentColor|ButtonText)(?=(?:$| ))/g;

// 删除源码css中的所有颜色值，避免冲突
const ReduceColorPlugin = postcss.plugin('ReduceColorPlugin', () => (root) => {
  function walkDecls(rule) {
    rule.walkDecls((decl) => {
      if (/(color|box-shadow)$/.test(decl.prop)) {
        decl.remove();
      } else if (/^(border|outline)(\-(left|right|top|bottom))?$/.test(decl.prop)) {
        decl.remove();
      } else if (/^background$/.test(decl.prop) && !/url\(/.test(decl.value)) {
        decl.remove();
      }
    });

    if (!rule.nodes.length) {
      rule.remove();
    }
  }
  root.walkRules(walkDecls);

  // 如果atRule中没有rule，则删除自身
  root.walkAtRules(walkDecls);
});

// 将源码css中的颜色值单独提取出来
const ExtractColorPlugin = postcss.plugin('ExtractColorPlugin', () => (root) => {
  function walkDecls(rule) {
    rule.walkDecls((decl) => {
      if (/(color|box-shadow)$/.test(decl.prop) || /^(border|outline)(\-(left|right|top|bottom))?$/.test(decl.prop)) {
        return;
      }
      if (/^background$/.test(decl.prop) && !/url\(/.test(decl.value)) {
        return;
      }
      decl.remove();
    });

    if (!rule.nodes.length) {
      rule.remove();
    }
  }
  // 遍历所有的rule
  root.walkRules(walkDecls);
  // 这里主要是删除getCssFromAsset方法做的标记
  root.walkComments((c) => c.remove());
  // 如果atRule中没有rule，则删除自身
  root.walkAtRules(walkDecls);
});

/**
 *
 * @param {*} content css内容
 * @description 从给定的css中筛选出颜色规则
 */
async function extractColor(content, colors) {
  const result = await postcss([ExtractColorPlugin(colors)]).process(content, { from: undefined });
  return result.css;
}

/**
 *
 * @param {*} content css内容
 * @description 从给定的css中删除颜色规则
 */
async function reduceColor(content, colors) {
  const result = await postcss([ReduceColorPlugin(colors)]).process(content, { from: undefined });
  return result.css;
}

/**
 * @description 生成随机颜色
 */
function randomColor() {
  return `#${(0x1000000 + (Math.random()) * 0xffffff).toString(16).substr(1, 6)}`;
}

/**
 *
 * @param {*} color 传入的变量
 * @param {*} customColorRegexArray 额外的正则判断
 * @description 校验变量的值是否为一个颜色
 */
function isValidColor(color, customColorRegexArray = []) {
  if (color && color.includes('rgb')) return true;
  if (!color || color.match(/px/g)) return false;
  if (color.match(/colorPalette|fade/g)) return true;
  if (color.charAt(0) === '#') {
    color = color.substring(1);
    return (
      [3, 4, 6, 8].indexOf(color.length) > -1 && !Number.isNaN(parseInt(color, 16))
    );
  }
  // eslint-disable-next-line
  const isColor = /^(rgb|hsl|hsv)a?\((\d+%?(deg|rad|grad|turn)?[,\s]+){2,3}[\s\/]*[\d\.]+%?\)$/i.test(
    color,
  );
  if (isColor) return true;
  if (customColorRegexArray.length > 0) {
    return customColorRegexArray.reduce((prev, regex) => prev || regex.test(color), false);
  }
  return false;
}

/**
 *
 * @param {*} varName 当前变量
 * @param {*} mappings 从已知的变量集合中取
 * @description 递归获取一个变量的值
 */
function getColor(varName, mappings) {
  const color = mappings[varName];
  if (color in mappings) {
    return getColor(color, mappings);
  }
  return color;
}

/**
 *
 * @param {*} filePath 指定的less文件
 * @param {*} nodeModulesPath node_modules路径
 * @description 递归的获取一个less文件的内容
 */
function combineLess(filePath, nodeModulesPath) {
  const fileContent = fs.readFileSync(filePath).toString();
  const directory = path.dirname(filePath);
  return fileContent.split('\n')
    .map((line) => {
      if (line.startsWith('@import')) {
        let importPath = line.match(/@import ["'](.*)["'];/)[1];
        if (!importPath.endsWith('.less')) {
          importPath += '.less';
        }
        let newPath = path.join(directory, importPath);
        if (importPath.startsWith('~')) {
          importPath = importPath.replace('~', '');
          newPath = path.join(nodeModulesPath, `./${importPath}`);
        }
        return combineLess(newPath, nodeModulesPath);
      }
      return line;
    }).join('\n');
}

/**
 *
 * @param {String} content 文件内容
 * @param {*} customColorRegexArray 自定义的颜色校验数组
 * @description 根据文件内容，将颜色变量进行提取
 */
function generateColorMap(content, customColorRegexArray = []) {
  return content
    .split('\n')
    .filter((line) => line.startsWith('@') && line.indexOf(':') > -1)
    .reduce((prev, next) => {
      try {
        const matches = next.match(
          // (?=\S*[-]) 去掉 变量名必须要有中横杠 限制
          /([@a-zA-Z0-9-]+).*:[ ]{1,}(.*);/,
        );
        if (!matches) {
          return prev;
        }
        const varName = matches[1];
        let color = matches[2];
        if (color && color.startsWith('@')) {
          color = getColor(color, prev);
          if (!isValidColor(color, customColorRegexArray)) return prev;
          prev[varName] = color;
        } else if (isValidColor(color, customColorRegexArray)) {
          prev[varName] = color;
        }
        else if (COLORS[color]) {
          prev[varName] = COLORS[color];
        }
        return prev;
      } catch (e) {
        return prev;
      }
    }, {});
}

/**
 *
 * @param {*} filtPath less 文件
 * @description 获取指定文件的less变量
 */
function getLessVars(filtPath) {
  const sheet = fs.readFileSync(filtPath).toString();
  const lessVars = {};
  const matches = sheet.match(/@(.*:[^;]*)/g) || [];

  matches.forEach((variable) => {
    const definition = variable.split(/:\s*/);
    const varName = definition[0].replace(/['"]+/g, '').trim();
    lessVars[varName] = definition.splice(1).join(':');
  });
  return lessVars;
}

/**
 *
 * @param {*} text less 内容
 * @param {*} paths 文件上下文
 * @description 使用less渲染
 */
function render(text, paths) {
  return less.render(text, {
    paths,
    javascriptEnabled: true,
    plugins: [new NpmImportPlugin({ prefix: '~' })],
  });
}

function getDerivedVar(key, varName) {
  return key.replace(DERIVED_COLOR_TAG, varName);
}

/**
 * @param {*} themeVars 主题变量
 * @description 获取生成主题变量插值颜色的css
 */
function getThemeCompiledCss(themeVars, themeSelfVars, options) {
  let css = '';
  themeVars.forEach((varName) => {
    // 主题色
    css = `.${varName.replace('@', THEME_COMPILED_CSS_PREFIX)}{color:${varName};}\n${css}`;

    // 默认衍生颜色
    [1, 2, 3, 4, 5, 7, 8, 9, 10].forEach((key) => {
      const name = varName === '@primary-color' ? `@primary-${key}` : `${varName}-${key}`;
      css = `.${name.replace('@', THEME_COMPILED_CSS_PREFIX)}{color:${getShade(name)};}\n${css}`;
    });

    // 用户自定义的衍生颜色、iview/view-design下的衍生颜色
    if (options.derivedVars) {
      options.derivedVars.forEach((key, index) => {
        const name = `${varName}-derived-${index}`;
        css = `.${name.replace('@', THEME_COMPILED_CSS_PREFIX)}{color:${getDerivedVar(key, varName)};}\n${css}`;
      });
    }
  });
  // 不生成衍生色
  themeSelfVars.forEach((varName) => {
    css = `.${varName.replace('@', THEME_COMPILED_CSS_PREFIX)}{color:${varName};}\n${css}`;
  });
  return css;
}

/**
 *
 * @param {*} themeVars 主题变量
 * @param {*} uiColorFilePath ui颜色地址
 * @param {*} uiStyleDir ui颜色所在的文件夹，uiColorFilePath中的引用会基于该文件夹去寻找
 * @param {*} nodeModulesPath node_modules地址
 * @description 生成最终的变量对象，并且此时的变量对应的值为随机颜色值
 */
async function getThemeCompiledVars(
  themeVars,
  uiColorFilePath,
  uiStyleDir,
  nodeModulesPath,
  themeCompiledCss
) {
  let varsContent = '';
  const randomColorsVars = {};
  themeVars.forEach((varName) => {
    let color = randomColor();
    while (randomColorsVars[color]) {
      color = randomColor();
    }
    randomColorsVars[color] = varName;
    varsContent += `${varName}: ${color};\n`;
  });

  const colorFileContent = combineLess(uiColorFilePath, nodeModulesPath);
  let css = `${colorFileContent}\n${varsContent}\n${themeCompiledCss}`;

  const results = await render(css, [uiStyleDir]);
  css = results.css;
  css = css.replace(/(\/.*\/)/g, '');
  return getMatches(css, THEME_COMPILED_CSS_REGEXP);
}

function getOptions(options) {
  const ops = {
    // 切换主题的颜色
    themeVariables: [],
    // 如果UI不支持默认的这一套衍生颜色样式，那么就需要对每个颜色进行直接赋值
    // 以上场景可以使用这个变量
    themeSelfVariables: [],
    // 项目变量文件地址
    varFile: './src/assets/css/var.less',
    ui: 'view-design',
    // 项目使用的ui的样式文件夹
    uiStyleDir: './src/styles',
    // 在计算主题色相关颜色的时候会使用到
    uiColorFile: './custom.less',
    // 衍生变量生成函数文件地址
    colorPaletteFile: './color/colorPalette.less',
    isJsUgly: !isDev(),
    // 衍生变量
    derivedVars: [],
    // 判断是否为颜色
    customColorRegexArray: [],
    // 在哪些asset提取css；开发环境下处理根目录下的css、js；其他模式下只处理css文件夹下的css文件
    filterAssets: (k) => (isDev() ? cssOrJsDevRegExp : cssOrJsProRegExp).test(k),
    // 相关代码注入到哪些html中，默认只处理根目录下的html
    filterHtml: (k) => /^((?!\/).)+.html$/.test(k),
    // 在热更新时，需要将less内容先转成js字符串保存，这时候需要对内容做转义，默认情况下对单引号和反斜杠做了转义
    hmrTransformLess: (content) => content.replace(/\\/g, "\\\\").replace(/'/g, "\\'"),
    ...options,
  };
  ops.customColorRegexArray = dftCustomColorRegexArray.concat(ops.customColorRegexArray);
  ops.derivedVars = ['iview', 'view-design'].includes(ops.ui) ? IVIEW_DERIVED_VARS.concat(ops.derivedVars) : ops.derivedVars;
  return ops;
}

/**
 *
 */
function getCssFromAsset(fileName, targetAsset, regExp) {
  if (isDef(targetAsset._cssContent)) {
    return targetAsset._cssContent;
  }
  let result = '';
  if (cssFileRegExp.test(fileName)) {
    result = targetAsset.source().toString();
  } else if (jsFileRegExp.test(fileName)) {
    const jsContent = targetAsset.source().toString();
    let target = '';
    /**
     * 在处理js中的css代码时，由于字符串转义的原因，我们读取到的换行符、引号都被多次转义了，这里需要将它们转义回来；
     * 引号出现的位置目前有选择器中，eg: [target="_blank"] {}
     * 还有就是在url()中会出现，url中出现由于css-loader的原因，它和选择器的处理方式要区别开来
     * 这里没有处理url()中的引号，因为抽离的css只会包含颜色代码，url会被删掉
     */
    jsContent.replace(regExp, (match, $1) => {
      target = `${target}${target ? `\n${cssSplitTag}` : ''}\n${$1.replace(/\\\\n/g, '\n').replace(/\\\\\\"/g, '"')}`;
    });
    result = target;
  }
  targetAsset._cssContent = result;
  return result;
}

// 提取css
/**
 * @description 解析asset，提取颜色相关的css
 */
async function extractColorRule(css, asset) {
  if (isDef(asset._extractCssContent)) {
    return asset._extractCssContent;
  }
  const result = await extractColor(css);
  asset._extractCssContent = result;
  return result;
}

// 删除颜色相关的css
/**
 * @description 解析asset，删除颜色相关的css
 */
async function reduceColorRule(css, asset) {
  if (isDef(asset._reduceCssContent)) {
    return asset._reduceCssContent;
  }
  const result = await reduceColor(css);
  asset._reduceCssContent = result;
  return result;
}

/**
 * @description 替换asset中的css为给定的css
 */
function replaceAssetColor(assets, assetsKeys, cssArray, regExp) {
  assetsKeys.forEach((fileName, index) => {
    const asset = assets[fileName];
    if (asset._replaced) {
      return;
    }
    const css = cssArray[index];
    if (cssFileRegExp.test(fileName)) {
      assets[fileName].source = () => css;
      assets[fileName].size = () => css.length;
    } else if ((jsFileRegExp.test(fileName))) {
      const list = css.split(cssSplitTag);
      const jsContent = asset.source().toString();
      let i = 0;
      const content = jsContent.replace(regExp, (match, $1) => {
        /**
         * 这里对字符串转义处理的方式和getCssFromAsset中是相反的，需要注意的是引号只需要处理选择器中的引号，不需要处理url中的
         */
        const turnToOriginContent = (list[i++] || '').replace(/\n/g, '\\\\n').replace(/(?<!\\)"/g, '\\\\\\"');
        return match.replace($1, turnToOriginContent);
      });
      assets[fileName].source = () => content;
      assets[fileName].size = () => content.length;
    }
    asset._replaced = true;
  });
}

module.exports = class LessThemeWebpackPlugin {
  constructor(options) {
    this.options = options;
  }

  apply(compiler) {
    const options = getOptions(this.options);
    const {
      themeVariables,
      themeSelfVariables,
      customColorRegexArray,
      isJsUgly,
      filterAssets,
    } = options;

    const nodeModulesPath = path.resolve(compiler.context, './node_modules');

    const uiDir = IsPathExist(path.resolve(nodeModulesPath, `./${options.ui}`), `[${options.ui}] is not exist, you should install it!`);

    const uiStyleDir = IsPathExist(path.resolve(uiDir, options.uiStyleDir));

    const uiColorFilePath = IsPathExist(path.resolve(uiStyleDir, options.uiColorFile));

    const varFilePath = IsPathExist(path.resolve(compiler.context, options.varFile));

    /* -------- */

    

    let varFileContent = '';
    let themeCompiledCss = '';
    let mappings = null;

    let themeCompiledVars = {};
    let themeCompiledVarsString = '';

    // development模式
    compiler.hooks[isDev() ? 'watchRun' : 'beforeRun'].tapPromise(PLUGIN_NAME, async (compiler) => {
      const beforeVarFileContent = varFileContent;
      varFileContent = combineLess(varFilePath, nodeModulesPath);

      // 如果之前有变量内容，并且内容和最新的不一样，那么就需要重新走一波流程
      if (beforeVarFileContent && beforeVarFileContent === varFileContent) {
        return;
      }

      // less变量对象
      mappings = generateColorMap(varFileContent, customColorRegexArray);

      const themeVars = themeVariables.filter((name) => name in mappings);
      const themeSelfVars = themeSelfVariables.filter((name) => name in mappings);

      themeCompiledCss = getThemeCompiledCss(themeVars, themeSelfVars, options);

      themeCompiledVars = await getThemeCompiledVars(
        themeVars.concat(themeSelfVars),
        uiColorFilePath,
        uiStyleDir,
        nodeModulesPath,
        themeCompiledCss
      );
      // 生成对应的less变量字符串
      themeCompiledVarsString = Object.keys(themeCompiledVars).map((k) => `${k}: ${themeCompiledVars[k]};`).join('\n');
    });

    // 获取compilation
    compiler.hooks.compilation.tap(PLUGIN_NAME, (compilation) => {
      // 给loaderContext添加变量，以便loader能够获取它
      compilation.hooks.normalModuleLoader.tap(
        PLUGIN_NAME,
        (loaderContext) => {
          loaderContext[COLOR_NAME] = themeCompiledVarsString;
          loaderContext[THEME_FILE] = varFilePath;
        },
      );
    });

    compiler.hooks.emit.tapPromise(PLUGIN_NAME, async (compilation) => {
      const { assets } = compilation;
      const extractPromise = [];
      const reducePromise = [];
      const regExp = isJsUgly ? CSS_REGEXP_UGLY : CSS_REGEXP_DEV;
      // 只处理css或者js
      const assetsKeys = Object.keys(assets).filter(filterAssets);

      assetsKeys.forEach((key) => {
        const asset = assets[key];
        const css = getCssFromAsset(key, asset, regExp);
        // 如果是hmr，则跳过提取，但是要reduce
        if (!hmrJsFileRegExp.test(key)) {
          extractPromise.push(extractColorRule(css, asset));
        }
        reducePromise.push(reduceColorRule(css, asset));
      });

      replaceAssetColor(assets, assetsKeys, await Promise.all(reducePromise), regExp);

      // 最终得到的css文件内容
      const cssContent = await Promise.all(extractPromise).then((array) => array.join('\n').trim());

      /**
       * 其实到这一步，我们已经拿到了css颜色相关的样式内容，接下来只需要对这部分内容中的颜色进行替换，即可实现主题定制；
       * 替换采用的技术有很多，如css3变量、直接替换颜色值、less编译
       * 前两种需要自己解决主题变量衍生出来的二级变量的颜色生成方法
       * 而less编译的话，less.js本身是内置颜色生成方法的
       * 接下来我们使用less编译的这种方式实现主题定制
       */
      generateThemeUseLess({
        compiler,
        compilation,
        cssContent,
        mappings,
        themeCompiledVars,
        options,
        combineLess,
        themeCompiledCss
      });
    });
  }
};
