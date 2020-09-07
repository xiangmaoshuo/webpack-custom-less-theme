const { COLOR_NAME, THEME_FILE } = require('./constant');
module.exports = function lessThemeLoader(source) {
  this.addDependency(this[THEME_FILE]);
  return `${source}\n${this[COLOR_NAME]}`;
};
