/* eslint-disable no-param-reassign,no-plusplus,no-underscore-dangle */
const fs = require('fs');
const path = require('path');
const postcss = require('postcss');
const less = require('less');
const NpmImportPlugin = require('less-plugin-npm-import');

const generateThemeUseLess = require('./generate-theme-use-less');
const { PLUGIN_NAME, COLOR_NAME } = require('./constant');
const {
  getShade,
  minifyCss,
  hmrJsFileRegExp,
  isDef,
  isDev,
} = require('./utils');

const dftCustomColorRegexArray = ['color', 'lighten', 'darken', 'saturate', 'desaturate', 'fadein', 'fadeout', 'fade', 'spin', 'mix', 'hsv', 'tint', 'shade', 'greyscale', 'multiply', 'contrast', 'screen', 'overlay']
  .map((name) => new RegExp(`${name}\\(.*\\)`));

const CSS_REGEXP_DEV = /\bn?exports\.push\(\[module\.i, \\?"(.+?\})(?:\\?\\n)?(?:[\\n]*\/\*#\s*sourceMappingURL=.+?\*\/)?\\?", \\?"\\?"(?:\]\)|,\s*\{)/g;
const CSS_REGEXP_UGLY = /\.push\(\[\w+\.i,['"](.+?\})[\\rn]*['"],['"]['"](?:\]\)|,\{)/g;
const cssFileRegExp = /\.css$/;
const jsFileRegExp = /\.js$/;

const cssOrJsRegExp = /(?<!(^less.min))\.(css|js)$/;
// 用以标记js中的css
const cssSplitTag = '/* <get-css-from-asset-comment> */';

// 简单的匹配颜色的正则表达式
const matchColorRegExp = /(?<=(?:^| ))(#[a-f\d]+|rgb(?:a)?\(.*\))/;

// 删除源码css中的所有颜色值，避免冲突
const ReduceColorPlugin = postcss.plugin('ReduceColorPlugin', () => (root) => {
  root.walkRules((rule) => {
    rule.walkDecls(/(color|box-shadow)$/, (decl) => decl.remove());

    rule.walkDecls(/^(border|outline)$/, (decl) => {
      const value = decl.value.replace(matchColorRegExp, '').trim();
      let style = '';
      const width = value.replace(/solid|dashed|dotted/, (match) => {
        style = match;
        return '';
      }).trim();

      if (style) {
        rule.insertBefore(decl, decl.clone({
          prop: `${decl.prop}-style`,
          value: style,
        }));
      }

      if (width) {
        rule.insertBefore(decl, decl.clone({
          prop: `${decl.prop}-width`,
          value: width,
        }));
      }
      decl.remove();
    });

    rule.walkDecls(/^background$/, (decl) => {
      decl.value = decl.value.replace(matchColorRegExp, '').trim();
    });
    if (!rule.nodes.length) {
      rule.remove();
    }
  });

  // 如果atRule中没有rule，则删除自身
  root.walkAtRules((atRule) => {
    if (!atRule.nodes.length) {
      atRule.remove();
    }
  });
});

// 将源码css中的颜色值单独提取出来
const ExtractColorPlugin = postcss.plugin('ExtractColorPlugin', () => (root) => {
  // 这里会遍历所有的rule，包括atRule中的
  root.walkRules((rule) => {
    rule.walkDecls(/^(border|outline|background)$/, (decl) => {
      const hasColor = matchColorRegExp.exec(decl.value);
      if (hasColor) {
        decl.prop = `${decl.prop}-color`;
        // eslint-disable-next-line
        decl.value = hasColor[0];
      } else {
        decl.remove();
      }
    });

    // 删除url
    rule.walkDecls((decl) => {
      if (String(decl.value).match(/url\(.*\)/g)) {
        decl.remove();
      }
    });

    // 删除prop中不包含color或者box-shadow的decl
    rule.walkDecls(/^((?!(color|box-shadow)).)+$/, (decl) => decl.remove());
    if (!rule.nodes.length) {
      rule.remove();
    }
  });
  // 这里主要是删除getCssFromAsset方法做的标记
  root.walkComments((c) => c.remove());
  // 如果atRule中没有rule，则删除自身
  root.walkAtRules((atRule) => {
    if (!atRule.nodes.length) {
      atRule.remove();
    }
  });
});

/**
 *
 * @param {*} content css内容
 * @description 从给定的css中筛选出颜色规则
 */
async function extractColor(content) {
  const result = await postcss([ExtractColorPlugin]).process(content);
  return result.css;
}

/**
 *
 * @param {*} content css内容
 * @description 从给定的css中删除颜色规则
 */
async function reduceColor(content) {
  const result = await postcss([ReduceColorPlugin]).process(content);
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
          /(?=\S*['-])([@a-zA-Z0-9'-]+).*:[ ]{1,}(.*);/,
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
 * @param {*} string 给定字符串
 * @param {*} regex 给定正则
 * @description 从给定的字符串中返回匹配的正则组成的对象
 */
function getMatches(string, regex) {
  const matches = {};
  let match;
  // eslint-disable-next-line
  while ((match = regex.exec(string))) {
    if (match[2].startsWith('rgba') || match[2].startsWith('#')) {
      // eslint-disable-next-line
      matches[`@${match[1]}`] = match[2];
    }
  }
  return matches;
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
) {
  let css = '';
  const randomColors = {};
  const randomColorsVars = {};
  themeVars.forEach((varName) => {
    let color = randomColor();
    while (randomColorsVars[color]) {
      color = randomColor();
    }
    randomColors[varName] = color;
    randomColorsVars[color] = varName;
    css = `.${varName.replace('@', '')} { color: ${color}; }\n ${css}`;
  });

  let varsContent = '';
  themeVars.forEach((varName) => {
    [1, 2, 3, 4, 5, 7, 8, 9, 10].forEach((key) => {
      const name = varName === '@primary-color' ? `@primary-${key}` : `${varName}-${key}`;
      css = `.${name.replace('@', '')} { color: ${getShade(name)}; }\n ${css}`;
    });
    varsContent += `${varName}: ${randomColors[varName]};\n`;
  });

  const colorFileContent = combineLess(uiColorFilePath, nodeModulesPath);
  css = `${colorFileContent}\n${varsContent}\n${css}`;

  const results = await render(css, [uiStyleDir]);
  css = results.css;
  css = css.replace(/(\/.*\/)/g, '');
  const regex = /.(?=\S*['-])([.a-zA-Z0-9'-]+) {\n {2}color: (.*);/g;
  return getMatches(css, regex);
}

function getOptions(compiler, options) {
  const ops = {
    ...{
      // 切换主题的颜色
      themeVariables: ['@primary-color'],
      // 项目变量文件地址
      varFile: path.resolve(compiler.context, './src/assets/css/var.less'),
      ui: 'view-design',
      // 项目使用的ui的样式文件夹
      uiStyleDir: './src/styles',
      // 在计算主题色相关颜色的时候会使用到
      uiColorFile: './color/colors.less',
      // 最终对外输出的css文件名
      fileName: 'css/theme-colors-[contenthash:8].less',
      isJsUgly: !isDev,
    },
    ...options,
  };
  ops.customColorRegexArray = [
    ...(options.customColorRegexArray || []),
    ...dftCustomColorRegexArray,
  ];
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
    /**
     * {
     *    themeVariables: ['@primary-color'],
     *    varFile: path.resolve(compiler.context, './src/assets/css/var.less'),
     *    customColorRegexArray: [], // 一般用不到
     *    fileName: 'css/theme-colors-[contenthash:8].less', // generate-theme-use-less没有使用到
     *    ui: 'view-design',
     *    uiStyleDir: './src/styles',
     *    uiColorFile: './color/colors.less',
     *    isJsUgly: !isDev,
     * }
     */
    this.options = options;
  }

  apply(compiler) {
    const options = getOptions(compiler, this.options);
    const {
      themeVariables,
      varFile,
      customColorRegexArray,
      ui,
      fileName,
      isJsUgly,
    } = options;

    const nodeModulesPath = path.resolve(compiler.context, './node_modules');
    const uiDir = path.resolve(nodeModulesPath, `./${ui}`);
    const uiStyleDir = path.resolve(uiDir, options.uiStyleDir);
    const uiColorFilePath = path.resolve(uiStyleDir, options.uiColorFile);

    const varFileContent = combineLess(varFile, nodeModulesPath);

    // less变量对象
    const mappings = Object.assign(
      generateColorMap(varFileContent, customColorRegexArray),
      // getLessVars(varFile),
    );

    const themeVars = themeVariables.filter((name) => name in mappings && !name.match(/(.*)-(\d)/));

    let themeCompiledVars = {};
    let themeCompiledVarsString = '';

    // 生成随机主题变量，并注入到 loaderContext
    compiler.hooks.beforeCompile.tapPromise(PLUGIN_NAME, async () => {
      // 如果已经生成了主题字符串，则不再执行了
      // 目的是为了保证所有的less都使用的是同一组随机变量
      if (themeCompiledVarsString) {
        return;
      }
      themeCompiledVars = await getThemeCompiledVars(
        themeVars,
        uiColorFilePath,
        uiStyleDir,
        nodeModulesPath,
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
        },
      );
    });

    compiler.hooks.emit.tapPromise(PLUGIN_NAME, async (compilation) => {
      const { assets } = compilation;
      const extractPromise = [];
      const reducePromise = [];
      const regExp = isJsUgly ? CSS_REGEXP_UGLY : CSS_REGEXP_DEV;
      // 只处理css或者js
      const assetsKeys = Object.keys(assets).filter((k) => cssOrJsRegExp.test(k));

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
        compilation,
        fileName,
        cssContent,
        mappings,
        themeCompiledVars,
      });
    });
  }
};
