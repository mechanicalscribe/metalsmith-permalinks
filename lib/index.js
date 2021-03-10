'use strict';

const path = require('path');
const debug = require('debug')('metalsmith-permalinks');
const moment = require('moment');
const slugify = require('slugify');
const substitute = require('substitute');
const fs = require('fs');

const error = debug.extend('error');

/**
 * Maps the slugify function to slug to maintain compatibility
 *
 * @param  {String} text
 * @param  {Object} options
 *
 * @return {String}
 */
const slug = (text, options = {}) => {
  // extend if it's an object
  if (typeof options.extend === 'object' && options.extend !== null) {
    slugify.extend(options.extend);
  }

  return slugify(text, Object.assign({}, { lower: true }, options));
};

/**
 * Re-links content
 *
 * @param  {Object} data
 * @param  {Object} moved
 *
 * @return {Void}
 */

const relink = (data, moved) => {
  let content = data.contents.toString();
  Object.keys(moved).forEach(to => {
    const from = moved[to];
    content = content.replace(from, to);
  });
  data.contents = Buffer.from(content);
};

/**
 * Normalize an options argument.
 *
 * @param  {String/Object} options
 *
 * @return {Object}
 */
const normalize = options => {
  if (typeof options === 'string') {
    options = { pattern: options };
  }

  options = options || {};
  options.date =
    typeof options.date === 'string'
      ? format(options.date)
      : format('YYYY/MM/DD');
  options.relative = Object.prototype.hasOwnProperty.call(options, 'relative')
    ? options.relative
    : true;
  options.linksets = options.linksets || [];
  return options;
};

/**
 * Return a formatter for a given moment.js format `string`.
 *
 * @param {String} string
 * @return {Function}
 */
const format = string => date =>
  moment(date)
    .utc()
    .format(string);

/**
 * Get a list of sibling and children files for a given `file` in `files`.
 *
 * @param {String} file
 * @param {Object} files
 * @return {Object}
 */
const family = (file, files) => {
  const ret = {};
  let dir = path.dirname(file);

  if (dir === '.') {
    dir = '';
  }

  // debug('Looking for family files for %s in %s', file, dir);

  for (const key in files) {
    if (key === file) continue;
    if (key.indexOf(dir) !== 0) continue;
    if (html(key)) continue;

    const rel = key.slice(dir.length);

    // debug('Adding family file %s (%s) to %s', key, rel, file)

    ret[rel] = files[key];
  }

  return ret;
};

/**
 * Get a list of files that exists in a folder named after `file` for a given `file` in `files`.
 *
 * @param {String} file
 * @param {Object} files
 * @return {Object}
 */
const folder = (file, files) => {
  const bn = path.basename(file, path.extname(file));
  const family = {};
  let dir = path.dirname(file);

  if (dir === '.') {
    dir = '';
  }

  const sharedPath = path.join(dir, bn, '/');

  for (const otherFile in files) {
    if (otherFile === file) continue;
    if (otherFile.indexOf(sharedPath) !== 0) continue;
    if (html(otherFile)) continue;

    const remainder = otherFile.slice(sharedPath.length);
    family[remainder] = files[otherFile];
  }

  return family;
};

/**
 * Resolve a permalink path string from an existing file `path`.
 *
 * @param {String} str The path
 * @return {String}
 */
const resolve = str => {
  const base = path.basename(str, path.extname(str));

  let ret = path.dirname(str);

  if (base !== 'index') {
    ret = path.join(ret, base).replace(/\\/g, '/');
  }

  return ret;
};

/**
 * Replace a `pattern` with a file's `data`.
 *
 * @param {String} pattern (optional)
 * @param {Object} data
 * @param {Object} options
 *
 * @return {Mixed} String or Null
 */
const replace = (pattern, data, options) => {
  if (!pattern) return null;
  const keys = params(pattern);
  const ret = {};

  for (let i = 0, key; (key = keys[i++]); ) {
    const val = data[key];

    if (!val || (Array.isArray(val) && val.length === 0)) {
      return null;
    }

    if (val instanceof Date) {
      ret[key] = options.date(val);
    } else {
      if (typeof options.slug === 'function') {
        debug('slugifying "%s" for key "%s"', val, key)
        ret[key] = options.slug(val.toString());
      } else {
        ret[key] = slug(val.toString(), options.slug);
      }
    }
  }

  return substitute(pattern, ret);
};

/**
 * Get the params from a `pattern` string.
 *
 * @param {String} pattern
 * @return {Array}
 */
const params = pattern => {
  const matcher = /:(\w+)/g;
  const ret = [];
  let m;
  while ((m = matcher.exec(pattern))) ret.push(m[1]);
  return ret;
};

/**
 * Check whether a file is an HTML file.
 *
 * @param {String} str The path
 * @return {Boolean}
 */
const html = str => path.extname(str) === '.html';

/**
 * Metalsmith plugin that renames files so that they're permalinked properly
 * for a static site, aka that `about.html` becomes `about/index.html`.
 *
 * @param  {Object} options
 *   @property {String} pattern
 *   @property {String/Function} date
 *   @property {String} indexFile
 *   @property {Boolean/Function} unique
 *   @property {Boolean} duplicatesFail
 *
 * @return {Function}
 */
const plugin = options => {
  options = normalize(options);

  const { linksets } = options;

  linksets.forEach(ls => {
    Object.keys(ls.match).forEach(key => {
      if (typeof ls.match[key] === 'string') {
        ls.match[key] = new RegExp(ls.match[key]);
      }
    });
  });

  let defaultLinkset = linksets.find(ls => {
    return Boolean(ls.isDefault);
  });

  if (!defaultLinkset) {
    defaultLinkset = options;
  }

  const dupes = {};

  const findLinkset = file => {
    const set = linksets.find(ls => {
      return Object.keys(ls.match).reduce((sofar, key) => {
        if (!sofar) {
          return sofar;
        }

        // debug('Files %s %s %s %s', file.path, file.collection, key, file[key]);

        if (ls.match[key].test(file[key])) {
          debug("MATCHED", ls.match[key].toString(), file[key]);
          return true;
        }

        if (file[key] && file[key].indexOf) {
          return file[key].includes(ls.match[key]);
        }

        return false;
      }, true)
    });

    return set || defaultLinkset;
  };

  return (files, metalsmith, done) => {

    setImmediate(done);

    const defaultUniquePath = (targetPath, filesObj, filename, opts) => {

      debug("Using defaultUniquePath: %s, %s", targetPath, filename)

      const { indexFile } = opts;
      let target;
      let counter = 0;
      let postfix = '';
      do {
        target = path.join(
          `${targetPath}${postfix}`,
          indexFile || 'index.html'
        );
        if (options.duplicatesFail && files[target]) {
          error(`Target: ${target} already has a file assigned`);
          return done(`Permalinks: Clash with another target file ${target}`);
        }

        postfix = `-${++counter}`;
      } while (options.unique && files[target]);

      return target;
    };

    const makeUnique = typeof options.unique === 'function' ? options.unique : defaultUniquePath;

    Object.keys(files).forEach(file => {
      const data = files[file];   

      let inDirectories = true;

      // in filter 
      if (typeof options.fileFilter === "object") {
        inDirectories = options.fileFilter.test(data.path);
      }

      // out filter
      if (typeof options.ignoreFilter === "object") {
        inDirectories = !options.ignoreFilter.test(data.path);
      }

      if (!inDirectories) {
        debug("IGNORING %s", data.path);
        return;
      }

      // NEW: if `customSlug` function is present, add a 'slug' property to `data` for use in the pattern
      if (typeof options.customSlug === 'function') {
        data.slug = data.slug || options.customSlug(data);
      }

      // debug('checking file: %s', file);

      if (!html(file)) return;
      if (data.permalink === false) return;

      // const linkset = Object.assign({}, findLinkset(data), defaultLinkset);
      let linkset = findLinkset(data);

      debug("LINKSET", linkset);


      if (!linkset) {
        linkset = defaultLinkset;
      }
      debug('applying pattern: %s to file: %s', linkset.pattern, file);

      let ppath = replace(linkset.pattern, data, linkset) || resolve(file);

      let fam;
      switch (linkset.relative) {
        case true:
          fam = family(file, files);
          break;
        case 'folder':
          fam = folder(file, files);
          break;
        default:
        // nothing
      }

      // Override the path with `permalink` option
      if (
        Object.prototype.hasOwnProperty.call(data, 'permalink') &&
        data.permalink !== false
      ) {
        ppath = data.permalink;
      }

      const out = makeUnique(ppath, files, file, options);
      debug('Resolved file %s to %s', file, out);

      // track duplicates for relative files to maintain references
      const moved = {};

      if (fam) {
        for (const key in fam) {
          if (Object.prototype.hasOwnProperty.call(fam, key)) {
            const rel = path.posix.join(ppath, key);
            dupes[rel] = fam[key];
            moved[key] = rel;
          }
        }
      }

      // add to path data for use in links in templates
      data.path = ppath === '.' ? '' : ppath.replace(/\\/g, '/');

      if (!/html$/.test(data.path)) {
        data.path += "/index.html";
      }

      relink(data, moved);


      delete files[file];
      // debug('deleting %s', file);
      files[out] = data;

    });

    // add duplicates for relative files after processing to avoid double-dipping
    // note: `dupes` will be empty if `options.relative` is false
    Object.keys(dupes).forEach(dupe => {
      files[dupe] = dupes[dupe];
    });
  };
};

// Expose `plugin`
module.exports = plugin;
