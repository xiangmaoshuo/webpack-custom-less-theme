const { COLOR_NAME } = require('./constant');
module.exports = function lessThemeLoader(source) {
  return `${this[COLOR_NAME]}\n${source}`;
};