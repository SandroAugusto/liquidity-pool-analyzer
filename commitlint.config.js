// @ts-check
/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Trailers such as Co-Authored-By can exceed the default body width.
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
  },
};
